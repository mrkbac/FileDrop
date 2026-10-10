import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type AppEnv = { Bindings: Env; Variables: { email: string } };
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const staffOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (
    !c.env.ACCESS_AUD ||
    !c.env.ACCESS_TEAM_DOMAIN ||
    !c.env.ALLOWED_EMAIL_DOMAIN
  ) {
    throw new HTTPException(503, {
      message: "Staff sign-in is not configured yet.",
    });
  }
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token)
    throw new HTTPException(401, {
      message: "Sign in through Cloudflare Access.",
    });
  const issuer = `https://${c.env.ACCESS_TEAM_DOMAIN}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: c.env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "email"],
    });
    if (
      typeof payload.email !== "string" ||
      payload.email.split("@").length !== 2 ||
      !payload.email
        .toLowerCase()
        .endsWith(`@${c.env.ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)
    ) {
      throw new Error("Email outside allowed domain");
    }
    c.set("email", payload.email.toLowerCase());
  } catch {
    throw new HTTPException(403, {
      message: "Access denied. Sign in with your Sensmore account.",
    });
  }
  await next();
});

export const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    c.req.header("Origin") !== new URL(c.req.url).origin
  ) {
    throw new HTTPException(403, { message: "Use this site's upload page." });
  }
  await next();
});

export const limitLinks = createMiddleware<AppEnv>(async (c, next) => {
  const { success } = await c.env.LINK_LIMITER.limit({
    key: c.req.header("CF-Connecting-IP") ?? "local",
  });
  if (!success) {
    c.header("Retry-After", "60");
    throw new HTTPException(429, {
      message: "Too many attempts. Try again in a minute.",
    });
  }
  await next();
});
