"""
Simulates browser behavior: connects, sends continuous silent PCM audio
(like the ScriptProcessor would), and receives responses.
"""
import asyncio
import json
import struct
import websockets

async def main():
    uri = "ws://localhost:8000/ws/test_user/test_audio_" + str(int(asyncio.get_event_loop().time()))
    print(f"Connecting to {uri}")

    async with websockets.connect(uri) as ws:
        print("Connected. Starting audio send + receive...")
        total_audio_recv = 0
        msg_count = 0

        # Simulate ScriptProcessor: send 4096-sample PCM frames at ~11 FPS
        # (4096 samples / 16000 Hz = 0.256s per frame, but browser sends faster
        # due to native sample rate downsampling)
        async def send_audio():
            """Send silent PCM audio like the browser does."""
            count = 0
            silence = b'\x00' * (4096 * 2)  # 4096 samples * 2 bytes (int16)
            try:
                while True:
                    await ws.send(silence)
                    count += 1
                    if count <= 3 or count % 50 == 0:
                        print(f"  [send] Audio frame #{count}")
                    await asyncio.sleep(0.1)  # ~10 FPS
            except Exception as e:
                print(f"  [send] Stopped: {e}")

        async def recv_messages():
            nonlocal total_audio_recv, msg_count
            try:
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=30)
                    msg_count += 1
                    if isinstance(msg, bytes):
                        total_audio_recv += len(msg)
                        if total_audio_recv <= 50000 or msg_count % 10 == 0:
                            print(f"  [recv #{msg_count}] Audio: {len(msg)}b (total: {total_audio_recv})")
                    else:
                        data = json.loads(msg)
                        print(f"  [recv #{msg_count}] JSON type={data.get('type')}: {str(data.get('data',''))[:80]}")
            except asyncio.TimeoutError:
                print(f"\n  [recv] Timeout. Total audio: {total_audio_recv}b, messages: {msg_count}")
            except Exception as e:
                print(f"\n  [recv] Error: {e}")

        # Run both concurrently like the browser does
        send_task = asyncio.create_task(send_audio())
        recv_task = asyncio.create_task(recv_messages())

        # Wait for recv to finish (timeout or error)
        await recv_task
        send_task.cancel()

    print(f"\nDone. Total audio received: {total_audio_recv}b")

asyncio.run(main())
