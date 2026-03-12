import { eq } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { users } from "@/db/schema.js";
import type { SelectUser, InsertUser } from "@/db/schema.js";
import type { RawIGUser } from "@/types/index.js";

export function createUsers(rawUsers: RawIGUser[]): void {
  const db = getDB();
  const rows: InsertUser[] = rawUsers.map((u) => ({
    userId: u.interop_messaging_user_fbid,
    username: u.username ?? null,
    displayName: u.full_name ?? null,
    avatarUrl: u.profile_pic_url ?? null,
    isVerified: u.is_verified ?? false,
    platform: "instagram",
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
