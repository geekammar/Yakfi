-- Better Auth core field (v1.7): the synthetic issuer of the account's
-- provider. Sign-up writes "local:credential" for local (password)
-- accounts and sign-in matches the credential account by it — the
-- installed version's credential lookup requires the column.
ALTER TABLE "accounts" ADD COLUMN "issuer" TEXT;
