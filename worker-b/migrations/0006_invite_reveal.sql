-- 验证成功后 15 分钟内，可凭原邮箱验证码解密重取同一邀请码。
ALTER TABLE b_invite_requests ADD COLUMN reveal_iv TEXT;
ALTER TABLE b_invite_requests ADD COLUMN reveal_ct TEXT;
