Add-Type -AssemblyName System.DirectoryServices

$searcher = New-Object System.DirectoryServices.DirectorySearcher
$searcher.Filter = '(objectCategory=computer)'
$searcher.PageSize = 1000

@(
    'name',
    'dnshostname',
    'operatingsystem',
    'distinguishedname',
    'lastlogontimestamp',
    'useraccountcontrol'
) | ForEach-Object {
    $null = $searcher.PropertiesToLoad.Add($_)
}

$items = foreach ($result in $searcher.FindAll()) {
    $properties = $result.Properties

    $name = if ($properties['name'].Count) {
        [string]$properties['name'][0]
    } else { '' }

    $dns = if ($properties['dnshostname'].Count) {
        [string]$properties['dnshostname'][0]
    } else { '' }

    $os = if ($properties['operatingsystem'].Count) {
        [string]$properties['operatingsystem'][0]
    } else { '' }

    $dn = if ($properties['distinguishedname'].Count) {
        [string]$properties['distinguishedname'][0]
    } else { '' }

    $lastLogon = ''
    if ($properties['lastlogontimestamp'].Count) {
        try {
            $fileTime = [int64]$properties['lastlogontimestamp'][0]
            if ($fileTime -gt 0) {
                $lastLogon = [datetime]::FromFileTimeUtc($fileTime).ToLocalTime().ToString('o')
            }
        } catch {}
    }

    $uac = 0
    if ($properties['useraccountcontrol'].Count) {
        try { $uac = [int]$properties['useraccountcontrol'][0] } catch {}
    }

    $disabled = (($uac -band 2) -eq 2)
    $ou = $dn
    if ($dn -match '^CN=[^,]+,(.+)$') {
        $ou = $Matches[1]
    }

    [pscustomobject]@{
        Name      = $name
        DNS       = $dns
        Status    = 'Pending'
        IP        = ''
        OS        = $os
        OU        = $ou
        LastLogon = $lastLogon
        Disabled  = $disabled
        Enabled   = (-not $disabled)
    }
}

@($items) |
    Sort-Object Name |
    ConvertTo-Json -Depth 4 -Compress
