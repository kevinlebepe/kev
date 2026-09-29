import { createContext, useContext } from 'react';

export interface Me {
  user: { id: string; email: string; display_name: string };
  organisationId: string;
  permissions: string[];
  candidateId: string | null;
  mfaEnabled: boolean;
  /** The organisation requires two factor sign in for staff and it is not on yet: no staff access until it is. */
  mfaSetupRequired: boolean;
  mfaRequiredByOrganisation?: boolean;
}

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('Not signed in');
  return me;
}

export const can = (me: Me, permission: string) => me.permissions.includes(permission);
