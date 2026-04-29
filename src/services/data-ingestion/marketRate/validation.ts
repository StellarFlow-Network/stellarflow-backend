export function validatePrice(data: any): number {
  if (typeof data !== 'number' || !Number.isFinite(data) || data <= 0) {
    throw new Error('Price must be a positive number');
  }

  return data;
}
