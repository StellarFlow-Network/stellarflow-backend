"""Multi-chain portfolio balance snapshots with Redis-backed refreshes."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from src.cache.redis_cache import redis_cache

logger = logging.getLogger(__name__)
BALANCE_CACHE_TTL_SECONDS = 30
_tracked_addresses: dict[str, None] = {}


def _request_json(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = json.dumps(payload).encode() if payload is not None else None
    request = Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    try:
        with urlopen(request, timeout=5) as response:
            return json.loads(response.read())
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError(f"Balance provider request failed: {exc}") from exc


async def _fetch_stellar(address: str, url: str) -> list[dict[str, Any]]:
    account = await asyncio.to_thread(
        _request_json,
        f"{url.rstrip('/')}/accounts/{quote(address, safe='')}",
    )
    balances = []
    for balance in account.get("balances", []):
        is_native = balance.get("asset_type") == "native"
        balances.append(
            {
                "network": "stellar",
                "address": address,
                "asset_code": "XLM" if is_native else balance.get("asset_code"),
                "asset_issuer": None if is_native else balance.get("asset_issuer"),
                "amount": str(Decimal(balance["balance"])),
            }
        )
    return balances


async def _fetch_soroban(address: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    """Read token balances from a Soroban-aware indexer configured by deployment."""
    base_url = config["indexer_url"].rstrip("/")
    response = await asyncio.to_thread(
        _request_json,
        f"{base_url}/accounts/{quote(address, safe='')}/balances",
    )
    return [
        {
            "network": config.get("name", "soroban"),
            "address": address,
            "asset_code": token["asset_code"],
            "asset_issuer": token.get("contract_id"),
            "amount": str(Decimal(str(token["amount"]))),
        }
        for token in response.get("balances", [])
    ]


async def _fetch_evm(address: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
        raise ValueError("Portfolio address is not a valid EVM address")
    rpc_url = config["rpc_url"]
    native = await asyncio.to_thread(
        _request_json,
        rpc_url,
        {"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance", "params": [address, "latest"]},
    )
    if native.get("error"):
        raise RuntimeError(native["error"].get("message", "EVM RPC error"))
    balances = [
        {
            "network": config["name"],
            "asset_code": config.get("native_symbol", "ETH"),
            "asset_issuer": None,
            "amount": str(Decimal(int(native["result"], 16)) / Decimal(10**18)),
        }
    ]
    async def fetch_token(token: dict[str, Any]) -> dict[str, Any] | None:
        contract = token["contract_address"]
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", contract):
            return None
        call_data = "0x70a08231" + address[2:].lower().rjust(64, "0")
        result = await asyncio.to_thread(
            _request_json,
            rpc_url,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "eth_call",
                "params": [{"to": contract, "data": call_data}, "latest"],
            },
        )
        if result.get("error"):
            return None
        amount = Decimal(int(result["result"], 16)) / Decimal(10 ** int(token.get("decimals", 18)))
        return {
            "network": config["name"],
            "address": address,
            "asset_code": token["asset_code"],
            "asset_issuer": contract,
            "amount": str(amount),
        }

    token_results = await asyncio.gather(
        *(fetch_token(token) for token in config.get("tokens", [])),
        return_exceptions=True,
    )
    balances.extend(result for result in token_results if isinstance(result, dict))
    return balances


def _network_configs() -> list[tuple[str, Any]]:
    networks: list[tuple[str, Any]] = []
    horizon_url = os.getenv("HORIZON_URL", "https://horizon.stellar.org")
    networks.append(("stellar", lambda address: _fetch_stellar(address, horizon_url)))

    soroban_json = os.getenv("SOROBAN_BALANCE_INDEXERS", "[]")
    evm_json = os.getenv("PORTFOLIO_EVM_NETWORKS", "[]")
    try:
        for indexer in json.loads(soroban_json):
            if indexer.get("indexer_url"):
                name = indexer.get("name", "soroban")
                networks.append((name, lambda address, item=indexer: _fetch_soroban(address, item)))
        for config in json.loads(evm_json):
            if config.get("name") and config.get("rpc_url"):
                name = config["name"]
                networks.append((name, lambda address, item=config: _fetch_evm(address, item)))
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Portfolio network configuration must be valid JSON") from exc
    return networks


async def refresh_portfolio_balances(address: str) -> dict[str, Any]:
    networks = _network_configs()
    try:
        linked_addresses = json.loads(os.getenv("PORTFOLIO_ADDRESS_MAP", "{}")).get(
            address, {}
        )
    except (AttributeError, json.JSONDecodeError) as exc:
        raise RuntimeError("PORTFOLIO_ADDRESS_MAP must map wallet identities to chain addresses") from exc
    if not isinstance(linked_addresses, dict):
        raise RuntimeError("PORTFOLIO_ADDRESS_MAP entries must be objects")
    responses = await asyncio.gather(
        *(
            provider(linked_addresses.get(network, address))
            for network, provider in networks
        ),
        return_exceptions=True,
    )
    balances: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for (network, _), result in zip(networks, responses):
        if isinstance(result, BaseException):
            errors.append({"network": network, "message": str(result)})
        else:
            balances.extend(result)
    snapshot = {
        "address": address,
        "balances": balances,
        "errors": errors,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await redis_cache.set(
        f"stellarflow:portfolio:balances:{address}",
        json.dumps(snapshot),
        ttl=BALANCE_CACHE_TTL_SECONDS,
    )
    return snapshot


async def get_portfolio_balances(address: str) -> dict[str, Any]:
    _tracked_addresses.pop(address, None)
    _tracked_addresses[address] = None
    if len(_tracked_addresses) > 1000:
        _tracked_addresses.pop(next(iter(_tracked_addresses)))
    key = f"stellarflow:portfolio:balances:{address}"
    cached = await redis_cache.get(key)
    if cached:
        try:
            return json.loads(cached)
        except json.JSONDecodeError:
            logger.warning("Discarding invalid portfolio cache entry for %s", address)
    return await refresh_portfolio_balances(address)


async def portfolio_balance_refresh_loop() -> None:
    """Refresh recently requested addresses every 30 seconds in this API worker."""
    while True:
        await asyncio.sleep(BALANCE_CACHE_TTL_SECONDS)
        if _tracked_addresses:
            await asyncio.gather(
                *(refresh_portfolio_balances(address) for address in tuple(_tracked_addresses)),
                return_exceptions=True,
            )