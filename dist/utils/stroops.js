const STROOPS_PER_UNIT = 10_000_000;
export function toStroops(price) {
    const value = typeof price === "string" ? parseFloat(price) : price;
    return Math.round(value * STROOPS_PER_UNIT);
}
//# sourceMappingURL=stroops.js.map