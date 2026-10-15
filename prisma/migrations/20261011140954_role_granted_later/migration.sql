-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "grantedLater" TEXT[] DEFAULT ARRAY[]::TEXT[];
