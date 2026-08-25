if ($env:DSH_HOME) { $dst = Join-Path $env:DSH_HOME 'skills' }
else { $dst = Join-Path $HOME '.dsh\skills' }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Get-ChildItem -Directory skills | ForEach-Object {
  if (Test-Path (Join-Path $_.FullName 'SKILL.md')) {
    Copy-Item -Recurse -Force $_.FullName $dst
    Write-Host "已安装：$($_.Name)"
  }
}
Write-Host "完成。新建会话后，说「搭建知识体系框架」即可触发。"
