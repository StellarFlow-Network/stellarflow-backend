"""Generate and check the FastAPI OpenAPI contract."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from openapi_spec_validator import validate_spec

ROOT = Path(__file__).resolve().parents[1]
SPEC_PATH = ROOT / "openapi.json"
HTTP_METHODS = {"delete", "get", "head", "options", "patch", "post", "put", "trace"}
sys.path.insert(0, str(ROOT))


def generated_spec() -> dict[str, Any]:
    from app.main import app

    return app.openapi()


def canonical_json(spec: dict[str, Any]) -> str:
    return json.dumps(spec, indent=2, sort_keys=True) + "\n"


def operation_map(spec: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (path, method): operation
        for path, path_item in spec.get("paths", {}).items()
        for method, operation in path_item.items()
        if method in HTTP_METHODS
    }


def resolved_schema(spec: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    while "$ref" in schema and schema["$ref"].startswith("#/components/schemas/"):
        name = schema["$ref"].rsplit("/", 1)[-1]
        schema = spec.get("components", {}).get("schemas", {}).get(name, {})
    return schema


def schema_breaks(
    old_spec: dict[str, Any],
    new_spec: dict[str, Any],
    old: dict[str, Any],
    new: dict[str, Any],
    location: str,
) -> list[str]:
    old = resolved_schema(old_spec, old)
    new = resolved_schema(new_spec, new)
    breaks: list[str] = []
    if old.get("type") and new.get("type") and old["type"] != new["type"]:
        breaks.append(f"{location}: type changed from {old['type']} to {new['type']}")
    if "enum" in old and "enum" in new:
        removed_values = set(old["enum"]) - set(new["enum"])
        if removed_values:
            breaks.append(f"{location}: enum values removed: {sorted(removed_values)!r}")

    old_properties = old.get("properties", {})
    new_properties = new.get("properties", {})
    for name, old_property in old_properties.items():
        if name not in new_properties:
            breaks.append(f"{location}: property removed: {name}")
        else:
            breaks.extend(schema_breaks(old_spec, new_spec, old_property, new_properties[name], f"{location}.{name}"))

    old_required = set(old.get("required", []))
    new_required = set(new.get("required", []))
    missing_required = old_required - new_required
    if missing_required:
        breaks.append(f"{location}: required properties removed: {sorted(missing_required)!r}")
    added_required = new_required - old_required
    if added_required:
        breaks.append(f"{location}: properties made required: {sorted(added_required)!r}")

    if old.get("items") and new.get("items"):
        breaks.extend(schema_breaks(old_spec, new_spec, old["items"], new["items"], f"{location}[]"))
    return breaks


def compatibility_breaks(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    breaks: list[str] = []
    old_operations = operation_map(old)
    new_operations = operation_map(new)

    for operation_key in sorted(set(old_operations) - set(new_operations)):
        breaks.append(f"operation removed: {operation_key[0]} {operation_key[1].upper()}")

    for operation_key in sorted(set(old_operations) & set(new_operations)):
        old_operation = old_operations[operation_key]
        new_operation = new_operations[operation_key]
        location = f"{operation_key[0]} {operation_key[1].upper()}"
        old_parameters = {(p.get("in"), p.get("name")): p for p in old_operation.get("parameters", [])}
        new_parameters = {(p.get("in"), p.get("name")): p for p in new_operation.get("parameters", [])}
        for parameter_key in sorted(set(old_parameters) - set(new_parameters)):
            breaks.append(f"{location}: parameter removed: {parameter_key!r}")
        for parameter_key in sorted(set(new_parameters) - set(old_parameters)):
            if new_parameters[parameter_key].get("required"):
                breaks.append(f"{location}: new required parameter: {parameter_key!r}")
        for parameter_key in sorted(set(new_parameters) & set(old_parameters)):
            old_parameter = old_parameters[parameter_key]
            new_parameter = new_parameters[parameter_key]
            if old_parameter.get("required") and not new_parameter.get("required"):
                breaks.append(f"{location}: parameter is no longer required: {parameter_key!r}")
            breaks.extend(schema_breaks(old, new, old_parameter.get("schema", {}), new_parameter.get("schema", {}), f"{location} parameter {parameter_key!r}"))

        old_body = old_operation.get("requestBody")
        new_body = new_operation.get("requestBody")
        if old_body and not new_body:
            breaks.append(f"{location}: request body removed")
        elif old_body and new_body:
            if old_body.get("required") and not new_body.get("required"):
                breaks.append(f"{location}: request body is no longer required")
            old_schema = next(iter(old_body.get("content", {}).values()), {}).get("schema", {})
            new_schema = next(iter(new_body.get("content", {}).values()), {}).get("schema", {})
            breaks.extend(schema_breaks(old, new, old_schema, new_schema, f"{location} request body"))

        old_responses = old_operation.get("responses", {})
        new_responses = new_operation.get("responses", {})
        for status in sorted(set(old_responses) - set(new_responses)):
            breaks.append(f"{location}: response removed: {status}")
        for status in sorted(set(old_responses) & set(new_responses)):
            old_schema = next(iter(old_responses[status].get("content", {}).values()), {}).get("schema", {})
            new_schema = next(iter(new_responses[status].get("content", {}).values()), {}).get("schema", {})
            breaks.extend(schema_breaks(old, new, old_schema, new_schema, f"{location} response {status}"))
    return breaks


def load_spec(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as file:
        spec = json.load(file)
    validate_spec(spec)
    return spec


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="replace the checked-in OpenAPI artifact")
    parser.add_argument("--check", action="store_true", help="check formatting and backward compatibility")
    args = parser.parse_args()
    if args.write == args.check:
        parser.error("choose exactly one of --write or --check")

    current = generated_spec()
    validate_spec(current)
    rendered = canonical_json(current)
    if args.write:
        SPEC_PATH.write_text(rendered, encoding="utf-8")
        return 0
    if not SPEC_PATH.exists():
        print(f"Missing OpenAPI baseline: {SPEC_PATH}", file=sys.stderr)
        return 1
    baseline = load_spec(SPEC_PATH)
    if rendered != SPEC_PATH.read_text(encoding="utf-8"):
        print("OpenAPI artifact is stale; run python scripts/check_openapi.py --write", file=sys.stderr)
        return 1
    breaks = compatibility_breaks(baseline, current)
    if breaks:
        print("Incompatible OpenAPI changes detected:\n" + "\n".join(f"- {item}" for item in breaks), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())