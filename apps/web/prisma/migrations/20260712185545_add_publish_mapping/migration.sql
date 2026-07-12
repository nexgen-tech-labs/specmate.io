-- CreateTable
CREATE TABLE "PublishMapping" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tool" "PublishTarget" NOT NULL,
    "remoteProject" TEXT NOT NULL,
    "typeMap" JSONB NOT NULL,
    "fieldDefaults" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublishMapping_projectId_tool_key" ON "PublishMapping"("projectId", "tool");

-- AddForeignKey
ALTER TABLE "PublishMapping" ADD CONSTRAINT "PublishMapping_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

