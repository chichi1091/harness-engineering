export type PermissionAction = "read" | "edit" | "write";

export type PermissionLevel = "allow" | "deny";

export interface Permissions {
  read: PermissionLevel;
  edit: PermissionLevel;
  write: PermissionLevel;
}

export type ProfileMode = "readonly" | "write";

export declare const PERMISSION_ACTIONS: readonly PermissionAction[];

export declare const PERMISSION_LEVELS: readonly PermissionLevel[];

export declare function validatePermissions(permissions: unknown): string[];

export declare function resolveEffectivePermissions(
  permissions: Permissions,
  profileMode?: ProfileMode
): Readonly<Permissions>;
