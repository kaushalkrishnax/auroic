import { eq } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { users } from "@/db/schema.js";
import type { SelectUser, InsertUser } from "@/db/schema.js";
import type { PlatformUser } from "@/types/index.js";

export function createUsers(platformUsers: PlatformUser[]): void {
  const db = getDB();
  const rows: InsertUser[] = platformUsers.map((u) => ({
    userId: u.userId,
    username: u.username ?? null,
    displayName: u.displayName ?? null,
    avatarUrl: u.avatarUrl ?? null,
    isVerified: u.isVerified ?? false,
    platform: u.platform,
  }));

  if (rows.length === 0) return;
  db.insert(users).values(rows).onConflictDoNothing().run();
}

export function getUserByFbid(userId: string): SelectUser | undefined {
  return getDB().select().from(users).where(eq(users.userId, userId)).get();
}

export function getAllUsers(): SelectUser[] {
  return getDB().select().from(users).all();
}
