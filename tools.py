"""
FlowBlinq ACP tool wrappers for Guida ADK agent.
All ACP endpoints are public — no auth headers needed.
"""

import os
import httpx
from google.adk.tools import FunctionTool

FLOWBLINQ_API = os.getenv("FLOWBLINQ_API_URL", "https://dev-brands-api.flowblinq.com")
BRAND_ID = os.getenv("FLOWBLINQ_BRAND_ID", "")

_client = httpx.AsyncClient(timeout=15.0)


async def search_products(query: str, limit: int = 5) -> dict:
    """Search the FlowBlinq product catalog for baby food and supplies.

    Args:
        query: Natural language search query, e.g. "organic baby cereal 6 months"
        limit: Maximum number of products to return (default 5)

    Returns:
        Dictionary with product results including names, prices, availability, and images.
    """
    resp = await _client.get(
        f"{FLOWBLINQ_API}/acp/brands/{BRAND_ID}/feed",
        params={"q": query, "limit": limit, "format": "json"},
    )
    if resp.status_code != 200:
        return {"error": f"API returned {resp.status_code}", "products": []}

    data = resp.json()
    products = data.get("products", data.get("items", []))

    return {
        "products": [
            {
                "id": p.get("id", p.get("product_id", "")),
                "name": p.get("title", p.get("name", "")),
                "price": p.get("price", ""),
                "currency": p.get("currency", "USD"),
                "available": p.get("availability", p.get("available", "unknown")),
                "image_url": p.get("image_url", p.get("images", [None])[0] if p.get("images") else None),
                "description": p.get("description", "")[:200],
            }
            for p in products[:limit]
        ],
        "total_found": len(products),
    }


async def get_product_details(product_id: str) -> dict:
    """Get detailed information about a specific product.

    Args:
        product_id: The product UUID from search results.

    Returns:
        Full product details including nutritional info, ingredients, age range, and pricing.
    """
    resp = await _client.get(
        f"{FLOWBLINQ_API}/acp/brands/{BRAND_ID}/feed/product/{product_id}",
    )
    if resp.status_code != 200:
        return {"error": f"Product not found (HTTP {resp.status_code})"}

    p = resp.json()
    return {
        "id": p.get("id", product_id),
        "name": p.get("title", p.get("name", "")),
        "price": p.get("price", ""),
        "currency": p.get("currency", "USD"),
        "description": p.get("description", ""),
        "images": p.get("images", []),
        "attributes": p.get("attributes", p.get("custom_attributes", {})),
        "availability": p.get("availability", "unknown"),
        "variants": p.get("variants", []),
    }


async def check_availability(product_ids: list[str]) -> dict:
    """Check real-time availability for one or more products.

    Args:
        product_ids: List of product UUIDs to check.

    Returns:
        Availability status for each product (in_stock, limited, out_of_stock).
    """
    resp = await _client.post(
        f"{FLOWBLINQ_API}/acp/brands/{BRAND_ID}/feed/availability",
        json={"product_ids": product_ids},
    )
    if resp.status_code != 200:
        return {"error": f"Availability check failed (HTTP {resp.status_code})"}

    return resp.json()


async def add_to_cart(product_id: str, quantity: int = 1) -> dict:
    """Add a product to the shopping cart by creating a checkout session.

    Args:
        product_id: The product UUID to add.
        quantity: Number of units (default 1).

    Returns:
        Checkout session details with session_id for further actions.
    """
    resp = await _client.post(
        f"{FLOWBLINQ_API}/checkout/brands/{BRAND_ID}/sessions",
        json={
            "line_items": [{"product_id": product_id, "quantity": quantity}],
        },
    )
    if resp.status_code not in (200, 201):
        return {"error": f"Cart creation failed (HTTP {resp.status_code})"}

    session = resp.json()
    return {
        "session_id": session.get("id", session.get("session_id", "")),
        "status": session.get("status", "created"),
        "line_items": session.get("line_items", []),
        "total": session.get("total", ""),
    }


async def get_cart(session_id: str) -> dict:
    """Get the current state of a checkout session / cart.

    Args:
        session_id: The checkout session UUID.

    Returns:
        Cart contents, totals, and current status.
    """
    resp = await _client.get(
        f"{FLOWBLINQ_API}/checkout/brands/{BRAND_ID}/sessions/{session_id}",
    )
    if resp.status_code != 200:
        return {"error": f"Session not found (HTTP {resp.status_code})"}

    return resp.json()


# Export as ADK FunctionTools
search_products_tool = FunctionTool(search_products)
get_product_details_tool = FunctionTool(get_product_details)
check_availability_tool = FunctionTool(check_availability)
add_to_cart_tool = FunctionTool(add_to_cart)
get_cart_tool = FunctionTool(get_cart)
