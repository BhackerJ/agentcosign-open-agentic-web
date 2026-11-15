"""Switch the demo store between its two states by editing one product spec in Shopify.

Usage:
    python tools/set_demo_state.py --env <path to .env> [--store STORE1] missing|filled

`missing` removes dock.max_displays_4k60 from Demo Dock Duo (OAW-DOCK-04); `filled` sets it to 2.
This is the same edit a merchant makes on the product page in the Shopify admin.
"""
import argparse
import json
import pathlib
import sys

from create_dock_fixtures import Shop, read_env

KEY = {"namespace": "dock", "key": "max_displays_4k60"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", required=True)
    parser.add_argument("--store", default="STORE1")
    parser.add_argument("state", choices=["missing", "filled"])
    args = parser.parse_args()

    fixtures = json.loads((pathlib.Path(__file__).resolve().parent.parent / "store" / "shopify-fixtures.json").read_text())
    product = next(p for p in fixtures["products"] if p["withheld"] == KEY["key"])
    shop = Shop(read_env(args.env), args.store)
    if args.state == "filled":
        shop.mutate(
            """mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) {
                 metafields { id } userErrors { field message code } } }""",
            {"m": [{**KEY, "ownerId": product["id"], "type": "number_integer", "value": "2"}]}, "metafieldsSet")
    else:
        shop.mutate(
            """mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) {
                 deletedMetafields { key } userErrors { field message } } }""",
            {"m": [{**KEY, "ownerId": product["id"]}]}, "metafieldsDelete")
    print(f"{product['sku']} {product['title']}: {KEY['namespace']}.{KEY['key']} is now {args.state}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
