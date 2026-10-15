$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskPgBin = 'C:\Program Files\PostgreSQL\17\bin'
if (-not (Test-Path -LiteralPath "$taskPgBin\initdb.exe")) { throw 'PostgreSQL 17 is required for this local integration test.' }
$taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$taskCluster = [IO.Path]::GetFullPath((Join-Path $taskTempRoot ('arni-billing-test-' + [guid]::NewGuid().ToString('N'))))
$taskPortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$taskPortProbe.Start()
$taskPort = $taskPortProbe.LocalEndpoint.Port
$taskPortProbe.Stop()
$taskPgStarted = $false
$taskEnvironmentNames = @('PRISMA_DATABASE_URL', 'DATABASE_URL', 'ARNI_TEST_DATABASE_URL')
$taskSavedEnvironment = @{}
foreach ($taskName in $taskEnvironmentNames) { $taskSavedEnvironment[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
Push-Location $taskRepo
try {
	node scripts/test-bedrock-converse.cjs
	if ($LASTEXITCODE -ne 0) { throw 'Bedrock conversion checks failed' }
	node scripts/test-router-cache.cjs
	if ($LASTEXITCODE -ne 0) { throw 'Router cache checks failed' }
	& "$taskPgBin\initdb.exe" -D $taskCluster -U arni_budget_test --auth=trust --no-locale --encoding=UTF8 --no-sync
	if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
	# WaitForExit waits for pg_ctl, while Start-Process -Wait also waits for the server descendants.
	$taskStarter = Start-Process -FilePath "$taskPgBin\pg_ctl.exe" -ArgumentList @('-D', ('"' + $taskCluster + '"'), '-l', ('"' + (Join-Path $taskCluster 'server.log') + '"'), '-o', ('"-h 127.0.0.1 -p ' + $taskPort + '"'), '-w', 'start') -WindowStyle Hidden -PassThru
	if (-not $taskStarter.WaitForExit(30000) -or $taskStarter.ExitCode -ne 0) { throw 'Local PostgreSQL failed to start' }
	$taskPgStarted = $true
	& "$taskPgBin\createdb.exe" -h 127.0.0.1 -p $taskPort -U arni_budget_test arni_budget_test
	if ($LASTEXITCODE -ne 0) { throw 'Test database creation failed' }
	$env:PRISMA_DATABASE_URL = "postgresql://arni_budget_test@127.0.0.1:$taskPort/arni_budget_test"
	$env:DATABASE_URL = $env:PRISMA_DATABASE_URL
	$env:ARNI_TEST_DATABASE_URL = $env:PRISMA_DATABASE_URL
	$taskBaselineSchema = Join-Path $taskCluster 'before.prisma'
	$taskBaselineText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixtures\billing-before.prisma'))
	[IO.File]::WriteAllText($taskBaselineSchema, $taskBaselineText, [Text.UTF8Encoding]::new($false))
	& .\node_modules\.bin\prisma.cmd db push --skip-generate --schema $taskBaselineSchema
	if ($LASTEXITCODE -ne 0) { throw 'Baseline schema creation failed' }
	'INSERT INTO "User" ("id", "email", "tokenBalance", "updatedAt") VALUES (''migration-fixture'', ''migration@billing-test.invalid'', 12345, CURRENT_TIMESTAMP);' | & .\node_modules\.bin\prisma.cmd db execute --stdin --schema prisma/schema.prisma
	if ($LASTEXITCODE -ne 0) { throw 'Migration fixture creation failed' }
	& .\node_modules\.bin\prisma.cmd db execute --file deploy/billing/20261014-budget.sql --schema prisma/schema.prisma
	if ($LASTEXITCODE -ne 0) { throw 'Billing migration failed' }
	& .\node_modules\.bin\prisma.cmd db execute --file deploy/billing/20261014-media.sql --schema prisma/schema.prisma
	if ($LASTEXITCODE -ne 0) { throw 'Media migration failed' }
	& .\node_modules\.bin\prisma.cmd db execute --file deploy/billing/20261015-cache-usage.sql --schema prisma/schema.prisma
	if ($LASTEXITCODE -ne 0) { throw 'Cache usage migration failed' }
	node scripts/test-billing.cjs
	if ($LASTEXITCODE -ne 0) { throw 'Billing checks failed' }
	node scripts/test-media.cjs
	if ($LASTEXITCODE -ne 0) { throw 'Media checks failed' }
} finally {
	if ($taskPgStarted) { & "$taskPgBin\pg_ctl.exe" -D $taskCluster -m immediate -w stop }
	foreach ($taskName in $taskEnvironmentNames) { [Environment]::SetEnvironmentVariable($taskName, $taskSavedEnvironment[$taskName], 'Process') }
	Pop-Location
	# Only delete the verified directory created by this invocation under the system temp root.
	if ($taskCluster.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $taskCluster).StartsWith('arni-billing-test-')) {
		if (Test-Path -LiteralPath $taskCluster) { Remove-Item -LiteralPath $taskCluster -Recurse -Force }
	}
}
