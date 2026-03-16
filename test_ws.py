"""
Headless WebSocket test — connects like a browser, sends no audio,
waits for Guida's greeting response. Logs everything.
"""
import asyncio
import json
import websockets

async def main():
    uri = "ws://localhost:8000/ws/test_user/test_session_" + str(int(asyncio.get_event_loop().time()))
    print(f"Connecting to {uri}")

    async with websockets.connect(uri) as ws:
        print("Connected. Waiting for messages (30s timeout)...")
        total_audio = 0
        msg_count = 0

        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=30)
                msg_count += 1

                if isinstance(msg, bytes):
                    total_audio += len(msg)
                    print(f"  [{msg_count}] Audio: {len(msg)} bytes (total: {total_audio})")
                else:
                    data = json.loads(msg)
                    if data.get("type") == "text":
                        print(f"  [{msg_count}] Text ({data.get('author','')}): {data['data'][:100]}")
                    else:
                        print(f"  [{msg_count}] JSON: {json.dumps(data)[:120]}")

        except asyncio.TimeoutError:
            print(f"\nTimeout after {msg_count} messages. Audio total: {total_audio} bytes")
        except Exception as e:
            print(f"\nError after {msg_count} messages: {e}")

    print("Done.")

asyncio.run(main())
