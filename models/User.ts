import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';
import { UserServiceInterface } from '../types/index.js';

const SALT_ROUNDS = 10;

export const UserService: UserServiceInterface = {
  async create({ email, password }) {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    return prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        password: hashedPassword,
      },
    });
  },

  async findByEmail(email) {
    return prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, email: true, password: true },
    });
  },

  async comparePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
  },

  async deleteMany() {
    return prisma.user.deleteMany();
  },
};

export default UserService;
