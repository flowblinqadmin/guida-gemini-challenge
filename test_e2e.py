"""
End-to-end test: connect → receive greeting audio → send text →
verify tool calls + product data → verify audio response.
"""
import asyncio
import json
import websockets

async def main():
    ts = str(int(asyncio.get_event_loop().time()))
    uri = f"ws://localhost:8000/ws/test_e2e/sess_{ts}"
    print(f"1. Connecting to {uri}")

    async with websockets.connect(uri) as ws:
        print("2. Connected. Waiting for greeting audio...")

        audio_total = 0
        text_msgs = []
        tool_calls = []
        tool_results = []
        msg_count = 0
        phase = "greeting"

        async def recv_until(description, timeout=30, stop_on_tool_result=False):
            nonlocal audio_total, msg_count
            start = asyncio.get_event_loop().time()
            while True:
                remaining = timeout - (asyncio.get_event_loop().time() - start)
                if remaining <= 0:
                    print(f"   Timeout waiting for {description}")
                    return False
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    print(f"   Timeout waiting for {description}")
                    return False

                msg_count += 1
                if isinstance(msg, bytes):
                    audio_total += len(msg)
                    if audio_total % 20000 < len(msg):
                        print(f"   Audio: {audio_total}b total")
                else:
                    data = json.loads(msg)
                    dtype = data.get("type", "")
                    if dtype == "text":
                        text_msgs.append(data["data"])
                        print(f"   Text ({data.get('author','')}): {data['data'][:80]}")
                    elif dtype == "tool_call":
                        tool_calls.append(data)
                        print(f"   Tool call: {data['tool']}({json.dumps(data.get('args',{}))[:60]})")
                    elif dtype == "tool_result":
                        tool_results.append(data)
                        d = data.get("data", {})
                        if isinstance(d, dict) and "products" in d:
                            print(f"   Tool result: {data['tool']} → {len(d['products'])} products")
                            for p in d["products"][:3]:
                                print(f"     - {p.get('name','?')} | {p.get('price','')} {p.get('currency','')}")
                        else:
                            print(f"   Tool result: {data['tool']} → {json.dumps(d)[:80]}")
                        if stop_on_tool_result:
                            return True
                    elif dtype == "error":
                        print(f"   ERROR: {data.get('data','')[:100]}")

            return True

        # Phase 1: Receive greeting
        print("\n--- Phase 1: Greeting ---")
        await recv_until("greeting audio", timeout=15)
        print(f"   Greeting received: {audio_total}b audio, {len(text_msgs)} text msgs")

        # Phase 2: Send user message to trigger search
        print("\n--- Phase 2: Sending 'My baby is 8 months old' ---")
        await ws.send(json.dumps({
            "type": "text",
            "data": "My baby is 8 months old, what do you recommend?"
        }))

        # Phase 3: Wait for tool calls and results
        print("\n--- Phase 3: Waiting for response + tool calls ---")
        await recv_until("tool result + audio response", timeout=30, stop_on_tool_result=True)

        # Keep receiving for a bit more
        await recv_until("remaining audio", timeout=10)

        # Summary
        print(f"\n{'='*50}")
        print(f"E2E SUMMARY:")
        print(f"  Messages received: {msg_count}")
        print(f"  Audio total: {audio_total}b ({audio_total/1000:.0f}KB)")
        print(f"  Text messages: {len(text_msgs)}")
        print(f"  Tool calls: {len(tool_calls)}")
        print(f"  Tool results: {len(tool_results)}")
        for tr in tool_results:
            d = tr.get("data", {})
            if isinstance(d, dict) and "products" in d:
                print(f"  Products returned: {len(d['products'])}")
        print(f"{'='*50}")

        ok = audio_total > 10000 and len(tool_results) > 0
        print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")

asyncio.run(main())
