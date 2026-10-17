# Issue #1304: Collateral Vault Liquidation Penalty Distribution Engine

## Description

Distribute collected vault liquidation penalty fees across the liquidator bonus, protocol treasury reserves, and insurance pool reserves.

## Requirements

- Calculate the penalty split accurately (example: 60% liquidator bonus, 30% insurance pool, and 10% treasury).
- Route each share to its destination pool contract when liquidation settles.
- Record each distribution in the `liquidation_fee_logs` table.

## Acceptance Criteria

- The distributed shares add up to 100% of the collected penalty.
- Every liquidation fee split has a complete database audit record.
