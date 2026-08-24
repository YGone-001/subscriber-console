import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { isBulkMutableUser } from "@/lib/userAccessManagement";
import type { RoleKey, SysUser } from "../types";

export function useUserSelection(users: SysUser[], pagedUsers: SysUser[], currentUsername?: string) {
  const [selection, setSelection] = useState<string[]>([]);
  const [bulkRole, setBulkRole] = useState<RoleKey>("operator");
  const selectedUsernames = useMemo(
    () => selection.filter((username) => users.some((item) => item.username === username)),
    [selection, users],
  );
  const setSelectedUsernames: Dispatch<SetStateAction<string[]>> = useCallback((update) => {
    setSelection((current) => {
      const validCurrent = current.filter((username) => users.some((item) => item.username === username));
      const next = typeof update === "function" ? update(validCurrent) : update;
      return next.filter((username) => users.some((item) => item.username === username));
    });
  }, [users]);

  const selectedUsers = useMemo(
    () => users.filter((item) => selectedUsernames.includes(item.username)),
    [selectedUsernames, users],
  );
  const mutableSelectedUsers = useMemo(
    () => selectedUsers.filter((item) => isBulkMutableUser(item, currentUsername)),
    [currentUsername, selectedUsers],
  );
  const allPageSelected = pagedUsers.length > 0 && pagedUsers.every((item) => selectedUsernames.includes(item.username));

  const togglePageSelection = () => {
    const pageNames = pagedUsers.map((item) => item.username);
    setSelectedUsernames((current) => allPageSelected
      ? current.filter((username) => !pageNames.includes(username))
      : Array.from(new Set([...current, ...pageNames])));
  };

  const toggleUserSelection = (username: string) => {
    setSelectedUsernames((current) => current.includes(username)
      ? current.filter((item) => item !== username)
      : [...current, username]);
  };

  return {
    selectedUsernames,
    setSelectedUsernames,
    selectedUsers,
    mutableSelectedUsers,
    allPageSelected,
    togglePageSelection,
    toggleUserSelection,
    bulkRole,
    setBulkRole,
  };
}
