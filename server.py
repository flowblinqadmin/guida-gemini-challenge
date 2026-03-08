"""
FastAPI WebSocket server bridging browser ↔ Gemini Live API via ADK.
Based on google/adk-samples bidi-demo pattern.

Architecture:
  Browser ←WebSocket→ FastAPI ←LiveRequestQueue→ ADK Runner.run_live() ←→ Gemini Live API
"""

import asyncio
import base64
import json
import os
import traceback
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.genai import types

from agent import guida_agent

load_dotenv()

APP_NAME = "guida"

app = FastAPI(title="Guida — AI Shopping Grandmother")
session_service = InMemorySessionService()
runner = Runner(
    agent=guida_agent,
    app_name=APP_NAME,
    session_service=session_service,
)

# Serve static frontend
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    user_id = f"user_{uuid.uuid4().hex[:8]}"
    session_id = f"session_{uuid.uuid4().hex[:8]}"

    # Create session in memory store
    session = await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
    )

    live_request_queue = LiveRequestQueue()

    # RunConfig for live streaming with native audio
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO", "TEXT"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Aoede",  # Warm, mature female voice
                )
            )
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(enabled=True),
        input_audio_transcription=types.AudioTranscriptionConfig(enabled=True),
    )

    async def upstream_task():
        """Browser WebSocket → ADK LiveRequestQueue (user input)."""
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                msg_type = msg.get("type", "")

                if msg_type == "audio":
                    audio_bytes = base64.b64decode(msg["data"])
                    live_request_queue.send_realtime(
                        types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                    )

                elif msg_type == "video":
                    frame_bytes = base64.b64decode(msg["data"])
                    live_request_queue.send_realtime(
                        types.Blob(data=frame_bytes, mime_type="image/jpeg")
                    )

                elif msg_type == "text":
                    live_request_queue.send_content(
                        types.Content(
                            role="user",
                            parts=[types.Part(text=msg["data"])],
                        )
                    )

                elif msg_type == "end":
                    live_request_queue.close()
                    break

        except WebSocketDisconnect:
            live_request_queue.close()
        except Exception as e:
            print(f"[upstream] Error: {e}")
            traceback.print_exc()
            live_request_queue.close()

    async def downstream_task():
        """ADK Runner.run_live() → Browser WebSocket (agent output)."""
        try:
            async for event in runner.run_live(
                session=session,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                if not event or not event.content or not event.content.parts:
                    continue

                for part in event.content.parts:
                    if part.text:
                        await ws.send_json({
                            "type": "text",
                            "data": part.text,
                            "author": event.author or "guida",
                        })

                    elif part.inline_data and part.inline_data.data:
                        mime = part.inline_data.mime_type or ""
                        if "audio" in mime:
                            await ws.send_json({
                                "type": "audio",
                                "data": base64.b64encode(
                                    part.inline_data.data
                                ).decode(),
                                "mime_type": mime,
                            })

                    elif part.function_call:
                        await ws.send_json({
                            "type": "tool_call",
                            "tool": part.function_call.name,
                            "args": dict(part.function_call.args)
                            if part.function_call.args
                            else {},
                        })

                    elif part.function_response:
                        await ws.send_json({
                            "type": "tool_result",
                            "tool": part.function_response.name,
                            "data": part.function_response.response
                            if hasattr(part.function_response, "response")
                            else {},
                        })

        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"[downstream] Error: {e}")
            traceback.print_exc()
            try:
                await ws.send_json({"type": "error", "data": str(e)})
            except Exception:
                pass

    # Run upstream + downstream concurrently — the bidi-demo pattern
    try:
        await asyncio.gather(
            upstream_task(),
            downstream_task(),
        )
    except Exception as e:
        print(f"[session] Error: {e}")
    finally:
        print(f"[session] Ended: {user_id}/{session_id}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
