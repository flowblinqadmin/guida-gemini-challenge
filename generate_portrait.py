"""
Generate Guida's portrait using Gemini Image Generation.
Run once to create the avatar image.
"""

import os
from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image
from io import BytesIO

load_dotenv()

PROMPT = """\
A warm, friendly grandmother in her late 60s with silver hair in a soft bun, \
wearing reading glasses with thin blue frames. She has kind brown eyes, rosy cheeks, \
and a gentle smile. Soft warm lighting, portrait style, neutral background. \
She looks like someone who knows everything about cooking and feeding babies. \
Photorealistic, high quality portrait photo.\
"""


def generate_guida_portrait():
    client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

    response = client.models.generate_content(
        model="gemini-2.0-flash-exp",
        contents=PROMPT,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
        ),
    )

    os.makedirs("generated_assets", exist_ok=True)

    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.mime_type.startswith("image/"):
            img = Image.open(BytesIO(part.inline_data.data))
            # Save full portrait
            img.save("generated_assets/guida-portrait.png")
            # Save circular crop for avatar
            size = min(img.size)
            left = (img.width - size) // 2
            top = (img.height - size) // 2
            cropped = img.crop((left, top, left + size, top + size))
            cropped = cropped.resize((400, 400), Image.LANCZOS)
            cropped.save("static/guida-avatar.png")
            print(f"Portrait saved: generated_assets/guida-portrait.png")
            print(f"Avatar saved: static/guida-avatar.png")
            return

    print("No image generated — check API key and model availability")


if __name__ == "__main__":
    generate_guida_portrait()
