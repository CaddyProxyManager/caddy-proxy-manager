import { eq, or } from "drizzle-orm";
import db from "../db";
import { users } from "../db/schema";

/** The names a person types at a prompt: the sign-in name, or the full address. */
export async function findUserByConsoleName(username: string) {
  const name = username.trim().toLowerCase();
  return db.query.users.findFirst({
    where: or(
      eq(users.email, `${name}@localhost`),
      eq(users.email, name),
      eq(users.username, name),
    ),
  });
}
