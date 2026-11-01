-- 邀请码只在创建响应中显示一次，不再保留可回看的明文。
UPDATE relay_invites SET code = NULL;
