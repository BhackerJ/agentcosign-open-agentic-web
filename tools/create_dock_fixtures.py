"""Create the fictional docking-station products for the demo in a Shopify development store.

Usage:
    python tools/create_dock_fixtures.py --env <path to .env> [--store STORE1] [--apply]

Without --apply it only prints what it would create. It reads <STORE>_DOMAIN, <STORE>_CLIENT_ID,
<STORE>_CLIENT_SECRET and SHOPIFY_API_VERSION from the env file, and never prints them.

It creates four product metafield definitions in the `dock` namespace, the products below, and
one collection that holds them. Every product carries the tag in TAG, and the script refuses to
run when a product with that tag already exists. The products are not published to any sales
channel. With --apply it writes the created ids to store/shopify-fixtures.json.

The products start in the "missing information" state: DOCKS marks one spec as withheld, and
that metafield is not written. Filling it in is the merchant's fix that the demo shows.
"""
import argparse
import json
import pathlib
import sys

import httpx

TAG = "oaw-demo-20261115"
COLLECTION = {"title": "Docking Stations — Demo Collection", "handle": "oaw-docks-demo"}
NOTE = "<p>Fictional test product for a demo. It does not exist and cannot be bought.</p>"

DEFINITIONS = [
    {"key": "host_port", "name": "Host port", "type": "single_line_text_field"},
    {"key": "video_outputs", "name": "Video outputs", "type": "number_integer"},
    {"key": "max_displays_4k60", "name": "Displays at 4K 60 Hz", "type": "number_integer"},
    {"key": "power_delivery_w", "name": "Power delivery (W)", "type": "number_integer"},
]

# Prices are US dollars. `withheld` names a spec left out of the store until the merchant fills it in.
DOCKS = [
    {"sku": "OAW-DOCK-01", "title": "Demo Dock Travel", "price": "39.00",
     "specs": {"host_port": "USB-C (DisplayPort Alt Mode)", "video_outputs": 1, "max_displays_4k60": 1, "power_delivery_w": 45}},
    {"sku": "OAW-DOCK-02", "title": "Demo Dock Solo", "price": "59.00",
     "specs": {"host_port": "USB-C (DisplayPort Alt Mode)", "video_outputs": 1, "max_displays_4k60": 1, "power_delivery_w": 65}},
    {"sku": "OAW-DOCK-03", "title": "Demo Dock Duo Lite", "price": "89.00",
     "specs": {"host_port": "USB-C (DisplayPort Alt Mode)", "video_outputs": 2, "max_displays_4k60": 1, "power_delivery_w": 65}},
    {"sku": "OAW-DOCK-04", "title": "Demo Dock Duo", "price": "129.00", "withheld": "max_displays_4k60",
     "specs": {"host_port": "USB-C (DisplayPort Alt Mode)", "video_outputs": 2, "max_displays_4k60": 2, "power_delivery_w": 90}},
    {"sku": "OAW-DOCK-05", "title": "Demo Dock Trio Pro", "price": "199.00",
     "specs": {"host_port": "Thunderbolt 4", "video_outputs": 3, "max_displays_4k60": 3, "power_delivery_w": 100}},
]


def read_env(path: str) -> dict[str, str]:
    env = {}
    for line in pathlib.Path(path).read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key] = value.strip().strip('"').strip("'")
    return env


class Shop:
    def __init__(self, env: dict[str, str], store: str):
        self.domain = env[f"{store}_DOMAIN"]
        version = env["SHOPIFY_API_VERSION"]
        token = httpx.post(
            f"https://{self.domain}/admin/oauth/access_token",
            data={"grant_type": "client_credentials", "client_id": env[f"{store}_CLIENT_ID"],
                  "client_secret": env[f"{store}_CLIENT_SECRET"]},
            timeout=30,
        )
        token.raise_for_status()
        self.url = f"https://{self.domain}/admin/api/{version}/graphql.json"
        self.headers = {"X-Shopify-Access-Token": token.json()["access_token"]}

    def run(self, query: str, variables: dict | None = None) -> dict:
        response = httpx.post(self.url, headers=self.headers, json={"query": query, "variables": variables or {}}, timeout=60)
        response.raise_for_status()
        body = response.json()
        if body.get("errors"):
            raise RuntimeError(json.dumps(body["errors"]))
        return body["data"]

    def mutate(self, query: str, variables: dict, field: str) -> dict:
        result = self.run(query, variables)[field]
        if result["userErrors"]:
            raise RuntimeError(f"{field}: {json.dumps(result['userErrors'])}")
        return result


def metafields(dock: dict) -> list[dict]:
    types = {d["key"]: d["type"] for d in DEFINITIONS}
    return [{"namespace": "dock", "key": key, "type": types[key], "value": str(value)}
            for key, value in dock["specs"].items() if key != dock.get("withheld")]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", required=True)
    parser.add_argument("--store", default="STORE1")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    shop = Shop(read_env(args.env), args.store)
    existing = shop.run("query($q: String!) { products(first: 20, query: $q) { nodes { id title } } }",
                        {"q": f"tag:{TAG}"})["products"]["nodes"]
    if existing:
        print(f"Refusing: {len(existing)} product(s) already carry the tag {TAG} on {shop.domain}.")
        return 1
    print(f"Store: {shop.domain}")
    for dock in DOCKS:
        withheld = f" (withheld: {dock['withheld']})" if dock.get("withheld") else ""
        print(f"  {dock['sku']}  {dock['title']}  ${dock['price']}  {len(metafields(dock))} specs{withheld}")
    if not args.apply:
        print("Dry run. Pass --apply to create them.")
        return 0

    created = {"store": shop.domain, "tag": TAG, "definitions": [], "products": []}
    for definition in DEFINITIONS:
        result = shop.mutate(
            """mutation($d: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $d) {
                 createdDefinition { id key } userErrors { field message code } } }""",
            {"d": {**definition, "namespace": "dock", "ownerType": "PRODUCT", "pin": True}},
            "metafieldDefinitionCreate")
        created["definitions"].append(result["createdDefinition"])

    for dock in DOCKS:
        product = {
            "title": dock["title"], "descriptionHtml": NOTE, "vendor": "Demo (fictional)",
            "productType": "Docking station", "status": "ACTIVE", "tags": [TAG],
            "productOptions": [{"name": "Title", "values": [{"name": "Default Title"}]}],
            "variants": [{"optionValues": [{"optionName": "Title", "name": "Default Title"}],
                          "price": dock["price"], "inventoryItem": {"sku": dock["sku"], "tracked": False}}],
            "metafields": metafields(dock),
        }
        result = shop.mutate(
            """mutation($p: ProductSetInput!) { productSet(synchronous: true, input: $p) {
                 product { id handle variants(first: 1) { nodes { id } } } userErrors { field message code } } }""",
            {"p": product}, "productSet")
        node = result["product"]
        created["products"].append({"sku": dock["sku"], "title": dock["title"], "id": node["id"], "handle": node["handle"],
                                    "variant_id": node["variants"]["nodes"][0]["id"], "withheld": dock.get("withheld")})
        print(f"  created {dock['sku']} {node['id']}")

    result = shop.mutate(
        """mutation($c: CollectionInput!) { collectionCreate(input: $c) {
             collection { id handle } userErrors { field message } } }""",
        {"c": {**COLLECTION, "descriptionHtml": NOTE, "products": [p["id"] for p in created["products"]]}},
        "collectionCreate")
    created["collection"] = result["collection"]
    out = pathlib.Path(__file__).resolve().parent.parent / "store" / "shopify-fixtures.json"
    out.write_text(json.dumps(created, indent=2) + "\n")
    print(f"Collection {created['collection']['id']}. Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
