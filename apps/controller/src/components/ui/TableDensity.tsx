"use client";

/**
 * The signed-in user's table density, held in context because tables sit at every depth. State,
 * so Profile can change it and every table follows before the save round trip returns.
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { DEFAULT_TABLE_DENSITY, type TableDensity } from "@/src/lib/users/table-density";

type DensityState = { density: TableDensity; setDensity: (next: TableDensity) => void };

const TableDensityContext = createContext<DensityState>({
  density: DEFAULT_TABLE_DENSITY,
  setDensity: () => {},
});

export function TableDensityProvider({
  initial,
  children,
}: {
  initial: TableDensity;
  children: ReactNode;
}) {
  const [density, setDensity] = useState(initial);
  // The saved value wins once the layout re-renders with it - including one changed in another tab.
  useEffect(() => setDensity(initial), [initial]);
  return (
    <TableDensityContext.Provider value={{ density, setDensity }}>
      {children}
    </TableDensityContext.Provider>
  );
}

/** The density every table should render at. Balanced outside the dashboard. */
export function useTableDensity(): TableDensity {
  return useContext(TableDensityContext).density;
}

/** For the Profile control, which changes it. */
export function useSetTableDensity(): (next: TableDensity) => void {
  return useContext(TableDensityContext).setDensity;
}
