'use client'

import { createContext } from "react";

export const TenantContext = createContext<{ tenantId: string | null }>({ tenantId: null });

export const TenantProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <TenantContext.Provider value={{ tenantId: null }}>
      {children}
    </TenantContext.Provider>
  );
};

