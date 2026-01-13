import { useContext } from 'react';
import { TenantContext } from '@/context/TenantProvider';

export const useTenant = () => {
  return useContext(TenantContext);
};

