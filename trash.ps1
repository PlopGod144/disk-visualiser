param([string]$p)
Add-Type -AssemblyName Microsoft.VisualBasic
# AllDialogs so Windows itself warns when an item is too big for the Recycle Bin, instead of deleting it silently
if (Test-Path -LiteralPath $p -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'AllDialogs', 'SendToRecycleBin')
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'AllDialogs', 'SendToRecycleBin')
}
