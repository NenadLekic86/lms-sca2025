// Components
export * from './components/UserTable';
export * from './components/UserTableV2';
export * from './components/UserForm';
export * from './components/UserRow';
export * from './components/ProfileForm';

// Hooks
export * from './hooks/useUsers';

// API client (use this for all user operations)
export * from './api/users.api';

// Types & Validation
export * from './types/user.types';
export * from './validations/user.schema';

// Note: UserService is DEPRECATED - use usersApi instead
// export { UserService } from './service/user.service';
