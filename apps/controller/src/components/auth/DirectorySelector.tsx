"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Selector } from "@astryxdesign/core/Selector";

export type DirectoryChoice = { id: string; name: string };

/** The selector's value for the local account; a directory's is its id, a UUID. */
export const LOCAL_ACCOUNT_CHOICE = "local";

export type SignInSource =
  | { kind: "local"; directoryId?: undefined }
  | { kind: "directory"; directoryId?: string };

/**
 * Where the password goes. With one directory the server decides (local account first), so the
 * form never has to ask; with several, the person picks.
 */
export function signInSource(directories: DirectoryChoice[], choice: string): SignInSource {
  if (directories.length === 0) return { kind: "local" };
  if (directories.length === 1) return { kind: "directory" };
  if (choice === LOCAL_ACCOUNT_CHOICE) return { kind: "local" };
  return { kind: "directory", directoryId: choice };
}

export function useDirectoryChoice(directories: DirectoryChoice[], localLoginEnabled: boolean) {
  return useState<string>(
    localLoginEnabled || directories.length === 0 ? LOCAL_ACCOUNT_CHOICE : directories[0].id,
  );
}

/** Nothing unless there are several directories to choose between. */
export function DirectorySelector({
  directories,
  localLoginEnabled,
  value,
  onChange,
  isDisabled,
}: {
  directories: DirectoryChoice[];
  localLoginEnabled: boolean;
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("auth.login");
  if (directories.length < 2) return null;
  const options = [
    ...(localLoginEnabled ? [{ value: LOCAL_ACCOUNT_CHOICE, label: t("localAccount") }] : []),
    ...directories.map((directory) => ({ value: directory.id, label: directory.name })),
  ];
  return (
    <Selector
      label={t("signInWith")}
      options={options}
      value={value}
      onChange={onChange}
      isDisabled={isDisabled}
      width="100%"
    />
  );
}
