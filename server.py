"""
FastAPI WebSocket server bridging browser ↔ Gemini Live API via ADK.
Based on google/adk-samples bidi-demo pattern.

Architecture:
  Browser ←WebSocket→ FastAPI ←LiveRequestQueue→ ADK Runner.run_live() ←→ Gemini Live API
"""

import asyncio
import base64
import json
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

# Serve static frontend — mount AFTER the root route
# to avoid conflicts with "/" matching


@app.get("/")
async def index():
    return FileResponse("static/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(ws: WebSocket, user_id: str, session_id: str):
    await ws.accept()
    print(f"[session] Connected: {user_id}/{session_id}")

    # Get or create session
    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not session:
        session = await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id,
        )

    live_request_queue = LiveRequestQueue()

    # Native audio model → AUDIO response modality
    # Text transcripts come via input/output_audio_transcription
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Aoede",  # Warm, mature female voice
                )
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        session_resumption=types.SessionResumptionConfig(),
    )

    async def upstream_task():
        """Browser WebSocket → ADK LiveRequestQueue (user input)."""
        try:
            while True:
                message = await ws.receive()

                # Binary = raw PCM audio (most efficient path)
                if "bytes" in message and message["bytes"]:
                    live_request_queue.send_realtime(
                        types.Blob(
                            data=message["bytes"],
                            mime_type="audio/pcm;rate=16000",
                        )
                    )

                # Text = JSON envelope for text input, images, or control
                elif "text" in message and message["text"]:
                    msg = json.loads(message["text"])
                    msg_type = msg.get("type", "")

                    if msg_type == "audio":
                        # Fallback: base64-encoded audio
                        audio_bytes = base64.b64decode(msg["data"])
                        live_request_queue.send_realtime(
                            types.Blob(
                                data=audio_bytes,
                                mime_type="audio/pcm;rate=16000",
                            )
                        )

                    elif msg_type == "image":
                        # Camera frame: base64-encoded JPEG
                        frame_bytes = base64.b64decode(msg["data"])
                        live_request_queue.send_realtime(
                            types.Blob(
                                data=frame_bytes,
                                mime_type=msg.get("mimeType", "image/jpeg"),
                            )
                        )

                    elif msg_type == "text":
                        live_request_queue.send_content(
                            types.Content(
                                parts=[types.Part(text=msg["data"])],
                            )
                        )

                    elif msg_type == "end":
                        break

        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"[upstream] Error: {e}")
            traceback.print_exc()

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
                    # Audio response — send as raw binary for efficiency
                    if part.inline_data and part.inline_data.data:
                        mime = part.inline_data.mime_type or ""
                        if "audio" in mime:
                            await ws.send_bytes(part.inline_data.data)

                    # Text (transcription or direct text)
                    elif part.text:
                        await ws.send_json({
                            "type": "text",
                            "data": part.text,
                            "author": event.author or "guida",
                        })

                    # Tool call notification (for UI indicators)
                    elif part.function_call:
                        await ws.send_json({
                            "type": "tool_call",
                            "tool": part.function_call.name,
                            "args": dict(part.function_call.args)
                            if part.function_call.args
                            else {},
                        })

                    # Tool result (product data for UI cards)
                    elif part.function_response:
                        resp = {}
                        if hasattr(part.function_response, "response"):
                            resp = part.function_response.response
                        await ws.send_json({
                            "type": "tool_result",
                            "tool": part.function_response.name,
                            "data": resp,
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

    # Run both directions concurrently — the bidi-demo pattern
    try:
        await asyncio.gather(upstream_task(), downstream_task())
    except Exception as e:
        print(f"[session] Error: {e}")
    finally:
        live_request_queue.close()
        print(f"[session] Ended: {user_id}/{session_id}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
