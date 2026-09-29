import { createContext, useContext } from 'react';

export interface Me {
  user: { id: string; email: string; display_name: string };
  organisationId: string;
  permissions: string[];
  candidateId: string | null;
}

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('Not signed in');
  return me;
}

export const can = (me: Me, permission: string) => me.permissions.includes(permission);
