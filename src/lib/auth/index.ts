import type { Role } from "@/types";
import { hasCapability, type Capability } from "@/config/roles";

export const validateSession = async () => {
  return null;
};

export const checkPermissions = (role: Role, capability: Capability) => {
  return hasCapability(role, capability);
};