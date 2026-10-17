<#!
Audit by default. Apply is an explicit owner-run operation; this tool never
changes private data ACLs or claims isolation from code running as the owner.
!#>
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param([string]$Path=(Split-Path -Parent $PSScriptRoot),[switch]$Apply)
$ErrorActionPreference='Stop'
$target=(Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\')
$project=(Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath.TrimEnd('\')
if($target -ne $project){throw 'Only the current project root can be audited/applied'}
if((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse target refused'}
$acl=Get-Acl -LiteralPath $target
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
$broad=@('S-1-1-0','S-1-5-11','S-1-5-32-545')
$writeMask=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
$broadWrite=@($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -in $broad -and ($_.FileSystemRights -band $writeMask) })
$plan=[ordered]@{mode='audit';target=$target;owner=$ownerSid;executionUser=$identity.User.Value;executionUserIsOwner=($ownerSid -eq $identity.User.Value);inheritanceProtected=$acl.AreAccessRulesProtected;broadWriteRuleCount=$broadWrite.Count;applyImpact='Replace root ACL with owner, SYSTEM and Administrators only; inherited development-tool access can be lost. Existing child explicit rules require separate audit.';privateDataAcl='Separate from workspace code/runtime access';applied=$false}
if($Apply){
    $plan.mode='apply-plan'
    $plan | ConvertTo-Json -Depth 4 | Write-Output
    if($ownerSid -ne $identity.User.Value){throw 'Apply refused: execution user is not the project owner'}
    if($PSCmdlet.ShouldProcess($target,'Replace root access rules; development tools can lose access')){
        $next=New-Object Security.AccessControl.DirectorySecurity
        $next.SetOwner($identity.User);$next.SetAccessRuleProtection($true,$false)
        foreach($sid in @($ownerSid,'S-1-5-18','S-1-5-32-544')){
            $principal=New-Object Security.Principal.SecurityIdentifier($sid)
            $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
            $next.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $target -AclObject $next
        $check=Get-Acl -LiteralPath $target
        $actual=@($check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        $expected=@($ownerSid,'S-1-5-18','S-1-5-32-544') | Sort-Object -Unique
        $actualSids=@($actual | ForEach-Object {$_.IdentityReference.Value}) | Sort-Object -Unique
        if(!$check.AreAccessRulesProtected -or $actual.Count -ne $expected.Count -or (Compare-Object $expected $actualSids) -or $check.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid){throw 'Applied ACL verification failed'}
        foreach($entry in $actual){if($entry.AccessControlType -ne 'Allow' -or $entry.FileSystemRights -ne 'FullControl' -or $entry.IsInherited -or $entry.InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or $entry.PropagationFlags -ne 'None'){throw 'Applied ACL verification failed'}}
        $plan.applied=$true
    }
}
$plan | ConvertTo-Json -Depth 4
