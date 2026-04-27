export function validatePrice(data) {
    if (typeof data !== 'number' || !Number.isFinite(data) || data <= 0) {
        throw new Error('Price must be a positive number');
    }
    return data;
}
//# sourceMappingURL=validation.js.map