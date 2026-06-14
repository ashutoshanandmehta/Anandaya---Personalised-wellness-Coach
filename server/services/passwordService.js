import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export async function hashPassword(plainText) {
  return await bcrypt.hash(plainText, SALT_ROUNDS);
}

export async function verifyPassword(plainText, hash) {
  return await bcrypt.compare(plainText, hash);
}
