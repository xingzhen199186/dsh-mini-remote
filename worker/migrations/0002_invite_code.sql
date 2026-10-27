-- 运维台需要回看未使用的邀请码；只存 hash 时无法恢复。
-- 邀请码是一次性、短期的，页面本身由 Cloudflare Access 保护。
ALTER TABLE relay_invites ADD COLUMN code TEXT;
