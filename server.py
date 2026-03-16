"""
FastAPI WebSocket server bridging browser ↔ Gemini Live API via ADK.
Based on google/adk-samples bidi-demo pattern.
"""

import asyncio
import base64
import json
import traceback

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


@app.get("/")
async def index():
    return FileResponse("static/index.html", headers={"Cache-Control": "no-cache, no-store"})


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def no_cache_middleware(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store"
    return response


@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(ws: WebSocket, user_id: str, session_id: str):
    await ws.accept()
    print(f"[session] Connected: {user_id}/{session_id}")

    await session_service.create_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id,
    )

    live_request_queue = LiveRequestQueue()

    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=[types.Modality.AUDIO],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Aoede",
                )
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )

    # Kick off the conversation — Guida greets first
    live_request_queue.send_content(
        types.Content(
            parts=[types.Part(text="A new parent just connected. Give a warm, grandmotherly greeting — like you're happy to see them. Don't immediately ask about their baby or try to sell anything. Just say hello warmly in one short sentence, like 'Oh hello dear, welcome! How can I help you today?'")],
        )
    )

    audio_chunks_sent = 0

    async def upstream_task():
        """Browser → ADK: audio as binary, images/text/control as JSON."""
        nonlocal audio_chunks_sent
        print(f"[upstream] Started for {user_id}/{session_id}")
        try:
            while True:
                message = await ws.receive()

                if "bytes" in message and message["bytes"]:
                    data = message["bytes"]
                    if len(data) >= 320:
                        audio_chunks_sent += 1
                        if audio_chunks_sent <= 3 or audio_chunks_sent % 50 == 0:
                            print(f"[upstream] Audio chunk #{audio_chunks_sent}: {len(data)}b")
                        live_request_queue.send_realtime(
                            types.Blob(
                                data=data,
                                mime_type="audio/pcm;rate=16000",
                            )
                        )

                elif "text" in message and message["text"]:
                    msg = json.loads(message["text"])
                    msg_type = msg.get("type", "")
                    print(f"[upstream] JSON msg type={msg_type}")

                    if msg_type == "audio":
                        audio_bytes = base64.b64decode(msg["data"])
                        if len(audio_bytes) >= 320:
                            live_request_queue.send_realtime(
                                types.Blob(
                                    data=audio_bytes,
                                    mime_type="audio/pcm;rate=16000",
                                )
                            )

                    elif msg_type == "image":
                        live_request_queue.send_realtime(
                            types.Blob(
                                data=base64.b64decode(msg["data"]),
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
                        print(f"[upstream] End message received")
                        break

                elif "type" in message and message["type"] == "websocket.disconnect":
                    print(f"[upstream] WS disconnect frame received")
                    break

        except WebSocketDisconnect:
            print(f"[upstream] WebSocketDisconnect (normal)")
        except Exception as e:
            print(f"[upstream] Error: {e}")
            traceback.print_exc()
        finally:
            print(f"[upstream] Ended. Sent {audio_chunks_sent} audio chunks.")

    async def downstream_task():
        """ADK Runner.run_live() → Browser WebSocket."""
        print(f"[downstream] Starting run_live for {user_id}/{session_id}")
        event_count = 0
        audio_bytes_sent = 0
        text_msgs_sent = 0
        ws_dead = False

        async def safe_send_bytes(data):
            nonlocal ws_dead, audio_bytes_sent
            if ws_dead:
                return
            try:
                await ws.send_bytes(data)
                audio_bytes_sent += len(data)
                if audio_bytes_sent <= 50000 or audio_bytes_sent % 100000 < len(data):
                    print(f"[downstream] Sent audio: {len(data)}b (total: {audio_bytes_sent}b)")
            except Exception as e:
                print(f"[downstream] send_bytes failed: {e}")
                ws_dead = True

        async def safe_send_json(data):
            nonlocal ws_dead, text_msgs_sent
            if ws_dead:
                return
            try:
                await ws.send_json(data)
                text_msgs_sent += 1
                print(f"[downstream] Sent JSON #{text_msgs_sent}: type={data.get('type')}")
            except Exception as e:
                print(f"[downstream] send_json failed: {e}")
                ws_dead = True

        try:
            async for event in runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                event_count += 1

                # Log ALL events (not just first 5)
                has_content = bool(event and event.content and event.content.parts)
                author = getattr(event, 'author', '?') if event else '?'
                part_types = []
                if has_content:
                    for p in event.content.parts:
                        if p.inline_data:
                            part_types.append(f"audio({len(p.inline_data.data)}b)")
                        elif p.text:
                            part_types.append(f"text({len(p.text)}ch)")
                        elif p.function_call:
                            part_types.append(f"tool_call({p.function_call.name})")
                        elif p.function_response:
                            part_types.append(f"tool_result")
                        else:
                            part_types.append("unknown")
                print(f"[downstream] Event #{event_count} author={author} parts={part_types} ws_dead={ws_dead}")

                if ws_dead:
                    continue  # Keep draining events to avoid blocking run_live

                # Send transcriptions as text to chat
                if event and hasattr(event, 'output_transcription') and event.output_transcription:
                    tr = event.output_transcription
                    text = getattr(tr, 'text', '') or ''
                    text = text.strip()
                    if text:
                        print(f"[downstream] Output transcription: {text[:80]}")
                        await safe_send_json({
                            "type": "text",
                            "data": text,
                            "author": "guida",
                        })
                if event and hasattr(event, 'input_transcription') and event.input_transcription:
                    tr = event.input_transcription
                    text = getattr(tr, 'text', '') or ''
                    text = text.strip()
                    if text:
                        print(f"[downstream] Input transcription: {text[:80]}")
                        await safe_send_json({
                            "type": "text",
                            "data": text,
                            "author": "user",
                        })

                # Handle interruption — Gemini says user interrupted
                if event and hasattr(event, 'interrupted') and event.interrupted:
                    print(f"[downstream] Gemini interrupted — flushing client audio")
                    await safe_send_json({"type": "interrupted"})

                if not event or not event.content or not event.content.parts:
                    continue

                for part in event.content.parts:
                    # Audio response → raw binary
                    if part.inline_data and part.inline_data.data:
                        mime = part.inline_data.mime_type or ""
                        if "audio" in mime:
                            await safe_send_bytes(part.inline_data.data)

                    # Text — filter out thinking/reasoning blocks
                    elif part.text:
                        text = part.text.strip()
                        if text.startswith("**") and ("\n" in text or text.endswith("**")):
                            print(f"[downstream] Filtered thinking text: {text[:80]}...")
                            continue
                        if text:
                            await safe_send_json({
                                "type": "text",
                                "data": text,
                                "author": event.author or "guida",
                            })

                    # Tool call notification
                    elif part.function_call:
                        await safe_send_json({
                            "type": "tool_call",
                            "tool": part.function_call.name,
                            "args": dict(part.function_call.args)
                            if part.function_call.args
                            else {},
                        })

                    # Tool result → product data for UI
                    elif part.function_response:
                        resp = {}
                        if hasattr(part.function_response, "response"):
                            resp = part.function_response.response
                        print(f"[downstream] Tool result for {part.function_response.name}: type={type(resp).__name__} keys={list(resp.keys()) if isinstance(resp, dict) else 'N/A'}")
                        import json as _json
                        print(f"[downstream] Tool result RAW: {_json.dumps(resp, default=str)[:300]}")
                        if isinstance(resp, dict) and "products" in resp:
                            print(f"[downstream]   → {len(resp['products'])} products, first={resp['products'][0].get('name','?') if resp['products'] else 'none'}")
                        await safe_send_json({
                            "type": "tool_result",
                            "tool": part.function_response.name,
                            "data": resp,
                        })

            print(f"[downstream] run_live generator ended normally after {event_count} events")
        except WebSocketDisconnect:
            print(f"[downstream] WebSocketDisconnect after {event_count} events")
        except Exception as e:
            err_str = str(e)
            if "1000" in err_str:
                print(f"[downstream] Clean close (1000) after {event_count} events")
            elif "1008" in err_str:
                print(f"[downstream] Gemini 1008 error after {event_count} events — model limit hit")
                await safe_send_json({"type": "error", "data": "Connection to Guida was interrupted. Please restart the conversation."})
            else:
                print(f"[downstream] Error after {event_count} events: {e}")
                traceback.print_exc()
                await safe_send_json({"type": "error", "data": err_str})
        finally:
            print(f"[downstream] Ended. Events={event_count} AudioSent={audio_bytes_sent}b TextMsgs={text_msgs_sent}")

    try:
        await asyncio.gather(upstream_task(), downstream_task())
    except Exception as e:
        if "1000" not in str(e):
            print(f"[session] Error: {e}")
    finally:
        live_request_queue.close()
        print(f"[session] Ended: {user_id}/{session_id}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
