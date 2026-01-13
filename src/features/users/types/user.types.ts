import { Role } from '@/types';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  orgId: string;
  status: 'active' | 'inactive' | 'pending';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  orgId: string;
}

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  role?: Role;
  status?: 'active' | 'inactive' | 'pending';
}

export interface UserFilters {
  role?: Role;
  status?: 'active' | 'inactive' | 'pending';
  orgId?: string;
  search?: string;
}
