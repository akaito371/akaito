$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Address = 'http://localhost:8093/'

$BuildVersion = 'V11.2.1'
$BuildId = '20260721.20'
$LogDirectory = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDirectory 'server.log'

# Cache danh sách máy AD để tránh truy vấn lại hơn 1.400 đối tượng ở mỗi lần làm mới.
$AdCacheTtlSeconds = 300
$script:AdCacheJson = $null
$script:AdCacheCreated = [datetime]::MinValue

if (-not (Test-Path $LogDirectory)) {
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
}

function Write-ServerLog {
    param([string]$Level, [string]$Message)

    try {
        $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level.ToUpperInvariant(), $Message
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch {}
}

Write-ServerLog 'INFO' ("Starting DomainManager {0} build {1}" -f $BuildVersion, $BuildId)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($Address)

try {
    $listener.Start()
} catch {
    Write-ServerLog 'ERROR' ("Khong the mo dia chi {0}: {1}" -f $Address, $_.Exception.Message)
    Write-Host ''
    Write-Host 'KHONG THE KHOI DONG MAY CHU.' -ForegroundColor Red
    Write-Host ("Dia chi {0} dang bi chiem hoac bi Windows chan." -f $Address) -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ''
    Read-Host 'Nhan Enter de dong'
    exit 1
}

Write-Host ''
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host ' VST DOMAIN MANAGER V11.1' -ForegroundColor Green
Write-Host " $Address" -ForegroundColor Yellow
Write-Host ' Nhan Ctrl+C de dung may chu.' -ForegroundColor DarkGray
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host ''

function Send-Text {
    param(
        $Response,
        [string]$Text,
        [string]$ContentType = 'text/plain; charset=utf-8',
        [int]$StatusCode = 200
    )

    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Json {
    param($Response, $Object, [int]$StatusCode = 200)

    $json = $Object | ConvertTo-Json -Depth 8 -Compress
    Send-Text $Response $json 'application/json; charset=utf-8' $StatusCode
}

function Read-Body {
    param($Request)

    $reader = New-Object IO.StreamReader(
        $Request.InputStream,
        $Request.ContentEncoding
    )

    try {
        $content = $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }

    if ($content) {
        return $content | ConvertFrom-Json
    }

    return $null
}

function Test-ComputerBatch {
    param([string[]]$Names)

    $jobs = foreach ($name in @($Names)) {
        if ([string]::IsNullOrWhiteSpace($name)) { continue }

        $ping = New-Object Net.NetworkInformation.Ping
        try {
            [pscustomobject]@{
                Name = [string]$name
                Ping = $ping
                Task = $ping.SendPingAsync([string]$name, 900)
            }
        } catch {
            $ping.Dispose()
            [pscustomobject]@{
                Name = [string]$name
                Ping = $null
                Task = $null
            }
        }
    }

    $tasks = @($jobs | Where-Object { $_.Task } | ForEach-Object { $_.Task })
    if ($tasks.Count -gt 0) {
        try {
            [void][Threading.Tasks.Task]::WaitAll(
                [Threading.Tasks.Task[]]$tasks,
                1500
            )
        } catch {}
    }

    foreach ($job in $jobs) {
        $status = 'Offline'
        $ip = ''

        try {
            if ($job.Task -and $job.Task.IsCompleted -and -not $job.Task.IsFaulted) {
                $reply = $job.Task.Result
                if ($reply.Status -eq [Net.NetworkInformation.IPStatus]::Success) {
                    $status = 'Online'
                    $ip = $reply.Address.ToString()
                }
            }
        } catch {
        } finally {
            if ($job.Ping) {
                try { $job.Ping.Dispose() } catch {}
            }
        }

        [pscustomobject]@{
            Name   = $job.Name
            Status = $status
            IP     = $ip
        }
    }
}


function New-DomainManagerCimSession {
    param([string]$Computer)

    $option = New-CimSessionOption -Protocol Dcom
    New-CimSession -ComputerName $Computer -SessionOption $option -ErrorAction Stop
}

function New-SectionResult {
    param([string]$Computer)

    [ordered]@{
        Success   = $false
        Partial   = $false
        Computer  = $Computer
        Error     = ''
        Diagnosis = ''
    }
}

function Get-ErrorDiagnosis {
    param([string]$Message)

    if ($Message -match 'Access is denied|0x80070005') {
        return 'Tài khoản hiện tại không có đủ quyền trên máy đích.'
    }
    if ($Message -match 'RPC server is unavailable|0x800706BA') {
        return 'RPC/WMI không phản hồi. Kiểm tra Firewall và dịch vụ WMI/RPC.'
    }
    if ($Message -match 'timed out|timeout|operation time') {
        return 'Máy đích phản hồi quá chậm hoặc kết nối WMI/CIM bị chặn.'
    }
    if ($Message -match 'No such host|network path was not found|name resolution') {
        return 'Không phân giải được tên máy hoặc không tìm thấy đường mạng.'
    }

    'Không lấy được dữ liệu CIM từ máy đích.'
}

function Get-ComputerBasicInfo {
    param([string]$Computer)

    $result = New-SectionResult $Computer
    $result.User = ''
    $result.IP = ''
    $result.Windows = ''
    $result.UptimeSeconds = 0

    try {
        $ping = @(Test-ComputerBatch @($Computer) | Select-Object -First 1)
        if ($ping.Count -and $ping[0].Status -eq 'Online') {
            $result.IP = [string]$ping[0].IP
        }
    } catch {}

    $session = $null
    try {
        $session = New-DomainManagerCimSession $Computer
        $os = Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem -OperationTimeoutSec 4 -ErrorAction Stop
        $cs = Get-CimInstance -CimSession $session -ClassName Win32_ComputerSystem -OperationTimeoutSec 4 -ErrorAction Stop

        $result.User = [string]$cs.UserName
        $result.Windows = ('{0} {1} (Build {2})' -f $os.Caption, $os.OSArchitecture, $os.BuildNumber).Trim()

        try {
            $boot = [datetime]$os.LastBootUpTime
            $result.UptimeSeconds = [int64]((Get-Date) - $boot).TotalSeconds
        } catch {}

        $result.Success = $true
        $result.Diagnosis = 'Thông tin chung đã tải thành công.'
    }
    catch {
        $result.Partial = -not [string]::IsNullOrWhiteSpace([string]$result.IP)
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }
    finally {
        if ($session) { Remove-CimSession $session -ErrorAction SilentlyContinue }
    }

    [pscustomobject]$result
}

function Get-ComputerHardwareInfo {
    param([string]$Computer)

    $result = New-SectionResult $Computer
    $result.Manufacturer = ''
    $result.Model = ''
    $result.CPU = ''
    $result.RAMBytes = 0
    $result.Serial = ''

    $session = $null
    $loaded = 0
    $errors = @()

    try {
        $session = New-DomainManagerCimSession $Computer

        try {
            $cs = Get-CimInstance -CimSession $session -ClassName Win32_ComputerSystem -OperationTimeoutSec 4 -ErrorAction Stop
            $result.Manufacturer = [string]$cs.Manufacturer
            $result.Model = [string]$cs.Model
            $result.RAMBytes = [int64]$cs.TotalPhysicalMemory
            $loaded++
        } catch { $errors += $_.Exception.Message }

        try {
            $cpu = Get-CimInstance -CimSession $session -ClassName Win32_Processor -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1
            $result.CPU = [string]$cpu.Name
            $loaded++
        } catch { $errors += $_.Exception.Message }

        try {
            $bios = Get-CimInstance -CimSession $session -ClassName Win32_BIOS -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1
            $result.Serial = [string]$bios.SerialNumber
            $loaded++
        } catch { $errors += $_.Exception.Message }

        $result.Success = ($loaded -eq 3)
        $result.Partial = ($loaded -gt 0 -and $loaded -lt 3)

        if ($result.Success) {
            $result.Diagnosis = 'Phần cứng đã tải thành công.'
        } else {
            $result.Error = ($errors | Select-Object -Unique) -join ' | '
            $result.Diagnosis = Get-ErrorDiagnosis $result.Error
        }
    }
    catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }
    finally {
        if ($session) { Remove-CimSession $session -ErrorAction SilentlyContinue }
    }

    [pscustomobject]$result
}

function Get-ComputerNetworkInfo {
    param([string]$Computer)

    $result = New-SectionResult $Computer
    $result.IP = ''
    $result.MAC = ''
    $result.Adapter = ''
    $result.Gateway = ''
    $result.DNS = @()
    $result.DHCPEnabled = $false
    $result.DHCPServer = ''

    $session = $null
    try {
        $session = New-DomainManagerCimSession $Computer
        $network = Get-CimInstance -CimSession $session -ClassName Win32_NetworkAdapterConfiguration -OperationTimeoutSec 5 -ErrorAction Stop |
            Where-Object { $_.IPEnabled -and $_.MACAddress } |
            Select-Object -First 1

        if (-not $network) {
            throw 'Không tìm thấy card mạng đang hoạt động.'
        }

        $result.MAC = [string]$network.MACAddress
        $result.Adapter = [string]$network.Description
        $result.IP = [string](@(
            $network.IPAddress |
            Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } |
            Select-Object -First 1
        ))
        $result.Gateway = [string](@(
            $network.DefaultIPGateway |
            Where-Object { $_ } |
            Select-Object -First 1
        ))
        $result.DNS = @(
            $network.DNSServerSearchOrder |
            Where-Object { $_ }
        )
        $result.DHCPEnabled = [bool]$network.DHCPEnabled
        $result.DHCPServer = [string]$network.DHCPServer

        $result.Success = $true
        $result.Diagnosis = 'Network đã tải thành công.'
    }
    catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }
    finally {
        if ($session) { Remove-CimSession $session -ErrorAction SilentlyContinue }
    }

    [pscustomobject]$result
}

function Get-ComputerDiskInfo {
    param([string]$Computer)

    $result = New-SectionResult $Computer
    $result.Disks = @()

    $session = $null
    try {
        $session = New-DomainManagerCimSession $Computer
        $disks = Get-CimInstance -CimSession $session -ClassName Win32_LogicalDisk -OperationTimeoutSec 5 -ErrorAction Stop |
            Where-Object { $_.DriveType -eq 3 }

        $result.Disks = @(
            $disks | ForEach-Object {
                [pscustomobject]@{
                    Device = [string]$_.DeviceID
                    Size   = [int64]$_.Size
                    Free   = [int64]$_.FreeSpace
                }
            }
        )

        $result.Success = $true
        $result.Diagnosis = 'Ổ đĩa đã tải thành công.'
    }
    catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }
    finally {
        if ($session) { Remove-CimSession $session -ErrorAction SilentlyContinue }
    }

    [pscustomobject]$result
}



function Invoke-ExternalPowerShellProbe {
    param(
        [string]$ScriptText,
        [int]$TimeoutMilliseconds = 6000
    )

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ScriptText))
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $psi

    try {
        [void]$process.Start()

        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            return [pscustomobject]@{
                Success = $false
                Timeout = $true
                Output = ''
                Error = "Hết thời gian chờ $([math]::Round($TimeoutMilliseconds / 1000, 1)) giây."
            }
        }

        $stdout = $process.StandardOutput.ReadToEnd().Trim()
        $stderr = $process.StandardError.ReadToEnd().Trim()

        [pscustomobject]@{
            Success = ($process.ExitCode -eq 0)
            Timeout = $false
            Output = $stdout
            Error = $stderr
        }
    }
    catch {
        [pscustomobject]@{
            Success = $false
            Timeout = $false
            Output = ''
            Error = $_.Exception.Message
        }
    }
    finally {
        try { $process.Dispose() } catch {}
    }
}

function New-DiagnosticResponse {
    param([string]$Name, [string]$Status, [string]$Detail)

    [pscustomobject]@{
        Name = $Name
        Status = $Status
        Detail = $Detail
    }
}

function Get-SingleComputerDiagnostic {
    param([string]$Computer, [string]$Test)

    switch ($Test.ToLowerInvariant()) {
        'dns' {
            try {
                $addresses = [Net.Dns]::GetHostAddresses($Computer) |
                    Where-Object AddressFamily -eq ([Net.Sockets.AddressFamily]::InterNetwork)
                if ($addresses) {
                    return New-DiagnosticResponse 'DNS Resolve' 'ok' (($addresses | ForEach-Object IPAddressToString) -join ', ')
                }
                return New-DiagnosticResponse 'DNS Resolve' 'fail' 'Không tìm thấy địa chỉ IPv4.'
            } catch {
                return New-DiagnosticResponse 'DNS Resolve' 'fail' $_.Exception.Message
            }
        }

        'ping' {
            try {
                $ping = New-Object Net.NetworkInformation.Ping
                try {
                    $reply = $ping.Send($Computer, 1500)
                    if ($reply.Status -eq [Net.NetworkInformation.IPStatus]::Success) {
                        return New-DiagnosticResponse 'Ping ICMP' 'ok' ("{0} ms - {1}" -f $reply.RoundtripTime, $reply.Address)
                    }
                    return New-DiagnosticResponse 'Ping ICMP' 'warning' ("Không phản hồi: {0}. Có thể Firewall chặn ICMP." -f $reply.Status)
                } finally {
                    $ping.Dispose()
                }
            } catch {
                return New-DiagnosticResponse 'Ping ICMP' 'warning' $_.Exception.Message
            }
        }

        'rpc' {
            if (Test-TcpPort $Computer 135 1800) { return New-DiagnosticResponse 'RPC Endpoint' 'ok' 'TCP 135 đang mở.' }
            return New-DiagnosticResponse 'RPC Endpoint' 'fail' 'TCP 135 không phản hồi.'
        }

        'smb' {
            if (Test-TcpPort $Computer 445 1800) { return New-DiagnosticResponse 'SMB' 'ok' 'TCP 445 đang mở.' }
            return New-DiagnosticResponse 'SMB' 'fail' 'TCP 445 không phản hồi.'
        }

        'winrm_http' {
            if (Test-TcpPort $Computer 5985 1800) { return New-DiagnosticResponse 'WinRM HTTP' 'ok' 'TCP 5985 đang mở.' }
            return New-DiagnosticResponse 'WinRM HTTP' 'warning' 'TCP 5985 đang đóng. Đây là tính năng tùy chọn; chỉ cần mở khi sử dụng PowerShell Remoting.'
        }

        'winrm_https' {
            if (Test-TcpPort $Computer 5986 1800) { return New-DiagnosticResponse 'WinRM HTTPS' 'ok' 'TCP 5986 đang mở.' }
            return New-DiagnosticResponse 'WinRM HTTPS' 'warning' 'TCP 5986 đang đóng. Đây là tính năng tùy chọn; chỉ cần mở khi sử dụng WinRM qua HTTPS.'
        }

        'admin_share' {
            $target = $Computer.Replace("'", "''")
            $probe = Invoke-ExternalPowerShellProbe "if (Test-Path '\\\\$target\\C$') { 'OK' } else { exit 2 }" 5000
            if ($probe.Success -and $probe.Output -match 'OK') {
                return New-DiagnosticResponse 'Admin Share C$' 'ok' "Truy cập được \\$Computer\C$."
            }
            $technical = if ($probe.Error) { $probe.Error } else { 'Không truy cập được hoặc thiếu quyền.' }
            $detail = "Không truy cập được C$. Có thể tài khoản thiếu quyền quản trị, chia sẻ quản trị bị tắt hoặc Firewall chặn SMB.||$technical"
            return New-DiagnosticResponse 'Admin Share C$' 'fail' $detail
        }

        'wmi' {
            $target = $Computer.Replace("'", "''")
            $script = "`$os = Get-WmiObject Win32_OperatingSystem -ComputerName '$target' -ErrorAction Stop; Write-Output (`$os.Caption + ' - Build ' + `$os.BuildNumber)"
            $probe = Invoke-ExternalPowerShellProbe $script 7000
            if ($probe.Success -and $probe.Output) { return New-DiagnosticResponse 'WMI/DCOM' 'ok' $probe.Output }
            return New-DiagnosticResponse 'WMI/DCOM' 'fail' $(if ($probe.Error) { $probe.Error } else { 'WMI không trả dữ liệu.' })
        }

        'cim' {
            $target = $Computer.Replace("'", "''")
            $script = @"
`$option = New-CimSessionOption -Protocol Dcom
`$session = New-CimSession -ComputerName '$target' -SessionOption `$option -ErrorAction Stop
try {
    `$cs = Get-CimInstance -CimSession `$session -ClassName Win32_ComputerSystem -OperationTimeoutSec 4 -ErrorAction Stop
    Write-Output ('Model: ' + `$cs.Model + '; User: ' + `$cs.UserName)
} finally {
    Remove-CimSession -CimSession `$session -ErrorAction SilentlyContinue
}
"@
            $probe = Invoke-ExternalPowerShellProbe $script 7500
            if ($probe.Success -and $probe.Output) { return New-DiagnosticResponse 'CIM DCOM' 'ok' $probe.Output }
            return New-DiagnosticResponse 'CIM DCOM' 'fail' $(if ($probe.Error) { $probe.Error } else { 'CIM không trả dữ liệu.' })
        }

        'wsman' {
            $target = $Computer.Replace("'", "''")
            $script = "`$r = Test-WSMan -ComputerName '$target' -ErrorAction Stop; Write-Output ('Protocol ' + `$r.ProtocolVersion)"
            $probe = Invoke-ExternalPowerShellProbe $script 6500
            if ($probe.Success -and $probe.Output) { return New-DiagnosticResponse 'PowerShell Remoting' 'ok' $probe.Output }
            return New-DiagnosticResponse 'PowerShell Remoting' 'warning' $(if ($probe.Error) { $probe.Error } else { 'WinRM chưa bật hoặc bị chặn.' })
        }

        'winmgmt' {
            $target = $Computer.Replace("'", "''")
            $script = "`$s = Get-Service -ComputerName '$target' -Name Winmgmt -ErrorAction Stop; Write-Output ('Status: ' + `$s.Status)"
            $probe = Invoke-ExternalPowerShellProbe $script 6500
            if ($probe.Success -and $probe.Output) {
                $status = if ($probe.Output -match 'Running') { 'ok' } else { 'warning' }
                return New-DiagnosticResponse 'Dịch vụ Winmgmt' $status $probe.Output
            }
            return New-DiagnosticResponse 'Dịch vụ Winmgmt' 'fail' $(if ($probe.Error) { $probe.Error } else { 'Không đọc được dịch vụ.' })
        }

        'eventlog' {
            $target = $Computer.Replace("'", "''")
            $script = "`$e = Get-WinEvent -ComputerName '$target' -LogName System -MaxEvents 1 -ErrorAction Stop; Write-Output ('Event ID ' + `$e.Id)"
            $probe = Invoke-ExternalPowerShellProbe $script 6500
            if ($probe.Success -and $probe.Output) { return New-DiagnosticResponse 'Remote Event Log' 'ok' $probe.Output }
            return New-DiagnosticResponse 'Remote Event Log' 'warning' $(if ($probe.Error) { $probe.Error } else { 'Không đọc được Event Log.' })
        }

        default {
            return New-DiagnosticResponse $Test 'fail' 'Phép thử không hợp lệ.'
        }
    }
}

function Test-TcpPort {
    param(
        [string]$Computer,
        [int]$Port,
        [int]$TimeoutMilliseconds = 1800
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($Computer, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($async)
        $true
    }
    catch {
        $false
    }
    finally {
        $client.Close()
    }
}

function Invoke-DiagnosticJob {
    param(
        [scriptblock]$ScriptBlock,
        [object[]]$ArgumentList = @(),
        [int]$TimeoutSeconds = 5
    )

    $job = Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList
    try {
        $done = Wait-Job -Job $job -Timeout $TimeoutSeconds
        if (-not $done) {
            Stop-Job -Job $job -Force -ErrorAction SilentlyContinue
            return [pscustomobject]@{
                Success = $false
                Timeout = $true
                Output  = $null
                Error   = "Hết thời gian chờ sau $TimeoutSeconds giây."
            }
        }

        try {
            $output = Receive-Job -Job $job -ErrorAction Stop
            return [pscustomobject]@{
                Success = $true
                Timeout = $false
                Output  = $output
                Error   = ''
            }
        }
        catch {
            return [pscustomobject]@{
                Success = $false
                Timeout = $false
                Output  = $null
                Error   = $_.Exception.Message
            }
        }
    }
    finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}

function Add-DiagnosticTest {
    param(
        [System.Collections.ArrayList]$List,
        [string]$Name,
        [string]$Status,
        [string]$Detail
    )

    [void]$List.Add([pscustomobject]@{
        Name   = $Name
        Status = $Status
        Detail = $Detail
    })
}

function Get-ComputerDiagnostic {
    param([string]$Computer)

    $tests = New-Object System.Collections.ArrayList

    # DNS
    try {
        $addresses = [System.Net.Dns]::GetHostAddresses($Computer) |
            Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork }
        if ($addresses) {
            Add-DiagnosticTest $tests 'DNS Resolve' 'ok' (($addresses | ForEach-Object IPAddressToString) -join ', ')
        }
        else {
            Add-DiagnosticTest $tests 'DNS Resolve' 'fail' 'Không tìm thấy địa chỉ IPv4.'
        }
    }
    catch {
        Add-DiagnosticTest $tests 'DNS Resolve' 'fail' $_.Exception.Message
    }

    # Ping
    try {
        $ping = New-Object System.Net.NetworkInformation.Ping
        $reply = $ping.Send($Computer, 1200)
        if ($reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) {
            Add-DiagnosticTest $tests 'Ping ICMP' 'ok' ("{0} ms - {1}" -f $reply.RoundtripTime, $reply.Address)
        }
        else {
            Add-DiagnosticTest $tests 'Ping ICMP' 'warning' ("Không phản hồi: {0}. Có thể Firewall chặn ICMP." -f $reply.Status)
        }
    }
    catch {
        Add-DiagnosticTest $tests 'Ping ICMP' 'warning' $_.Exception.Message
    }

    # Ports
    $portChecks = @(
        @{ Name = 'RPC Endpoint'; Port = 135; Detail = 'TCP 135' },
        @{ Name = 'SMB'; Port = 445; Detail = 'TCP 445' },
        @{ Name = 'WinRM HTTP'; Port = 5985; Detail = 'TCP 5985' },
        @{ Name = 'WinRM HTTPS'; Port = 5986; Detail = 'TCP 5986' },
        @{ Name = 'Remote Registry'; Port = 139; Detail = 'TCP 139 (NetBIOS)' }
    )

    foreach ($check in $portChecks) {
        if (Test-TcpPort -Computer $Computer -Port $check.Port) {
            Add-DiagnosticTest $tests $check.Name 'ok' ("{0} đang mở." -f $check.Detail)
        }
        else {
            $status = if ($check.Port -in 5985,5986,139) { 'warning' } else { 'fail' }
            Add-DiagnosticTest $tests $check.Name $status ("{0} không phản hồi." -f $check.Detail)
        }
    }

    # Admin share
    $share = Invoke-DiagnosticJob -TimeoutSeconds 4 -ArgumentList @($Computer) -ScriptBlock {
        param($Target)
        Test-Path ("\\{0}\C$" -f $Target) -ErrorAction Stop
    }
    if ($share.Success -and [bool]($share.Output | Select-Object -First 1)) {
        Add-DiagnosticTest $tests 'Admin Share C$' 'ok' 'Truy cập được \\MAY\C$.'
    }
    else {
        $detail = if ($share.Timeout) { 'Hết thời gian chờ.' } elseif ($share.Error) { $share.Error } else { 'Không truy cập được hoặc thiếu quyền.' }
        Add-DiagnosticTest $tests 'Admin Share C$' 'fail' $detail
    }

    # Legacy WMI
    $wmi = Invoke-DiagnosticJob -TimeoutSeconds 6 -ArgumentList @($Computer) -ScriptBlock {
        param($Target)
        $os = Get-WmiObject -Class Win32_OperatingSystem -ComputerName $Target -ErrorAction Stop
        [pscustomobject]@{ Caption = $os.Caption; Build = $os.BuildNumber }
    }
    if ($wmi.Success) {
        $item = $wmi.Output | Select-Object -First 1
        Add-DiagnosticTest $tests 'WMI/DCOM' 'ok' ("{0} - Build {1}" -f $item.Caption, $item.Build)
    }
    else {
        Add-DiagnosticTest $tests 'WMI/DCOM' 'fail' $(if ($wmi.Error) { $wmi.Error } else { 'Hết thời gian chờ.' })
    }

    # CIM DCOM
    $cim = Invoke-DiagnosticJob -TimeoutSeconds 6 -ArgumentList @($Computer) -ScriptBlock {
        param($Target)
        $option = New-CimSessionOption -Protocol Dcom
        $session = New-CimSession -ComputerName $Target -SessionOption $option -ErrorAction Stop
        try {
            $cs = Get-CimInstance -CimSession $session -ClassName Win32_ComputerSystem -OperationTimeoutSec 4 -ErrorAction Stop
            [pscustomobject]@{ Model = $cs.Model; User = $cs.UserName }
        }
        finally {
            Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue
        }
    }
    if ($cim.Success) {
        $item = $cim.Output | Select-Object -First 1
        Add-DiagnosticTest $tests 'CIM DCOM' 'ok' ("Model: {0}; User: {1}" -f $item.Model, $item.User)
    }
    else {
        Add-DiagnosticTest $tests 'CIM DCOM' 'fail' $(if ($cim.Error) { $cim.Error } else { 'Hết thời gian chờ.' })
    }

    # WinRM / WSMan
    $wsman = Invoke-DiagnosticJob -TimeoutSeconds 5 -ArgumentList @($Computer) -ScriptBlock {
        param($Target)
        Test-WSMan -ComputerName $Target -ErrorAction Stop | Select-Object ProductVersion, ProtocolVersion
    }
    if ($wsman.Success) {
        $item = $wsman.Output | Select-Object -First 1
        Add-DiagnosticTest $tests 'PowerShell Remoting' 'ok' ("WSMan {0}; Protocol {1}" -f $item.ProductVersion, $item.ProtocolVersion)
    }
    else {
        Add-DiagnosticTest $tests 'PowerShell Remoting' 'warning' $(if ($wsman.Error) { $wsman.Error } else { 'WinRM chưa bật hoặc bị Firewall chặn.' })
    }

    # Remote Service Control Manager
    $service = Invoke-DiagnosticJob -TimeoutSeconds 5 -ArgumentList @($Computer) -ScriptBlock {
        param($Target)
        Get-Service -ComputerName $Target -Name Winmgmt -ErrorAction Stop |
            Select-Object Name, Status, StartType
    }
    if ($service.Success) {
        $item = $service.Output | Select-Object -First 1
        $status = if ([string]$item.Status -eq 'Running') { 'ok' } else { 'warning' }
        Add-DiagnosticTest $tests 'Dịch vụ Winmgmt' $status ("Status: {0}; StartType: {1}" -f $item.Status, $item.StartType)
    }
    else {
        Add-DiagnosticTest $tests 'Dịch vụ Winmgmt' 'fail' $(if ($service.Error) { $service.Error } else { 'Không đọc được dịch vụ từ xa.' })
    }

    # Remote Event Log
    $eventLog = Invoke-DiagnosticJob -TimeoutSeconds 5 -ArgumentList @($Computer) -ScriptBlock {
        param($Target)
        Get-WinEvent -ComputerName $Target -LogName System -MaxEvents 1 -ErrorAction Stop |
            Select-Object Id, TimeCreated
    }
    if ($eventLog.Success) {
        $item = $eventLog.Output | Select-Object -First 1
        Add-DiagnosticTest $tests 'Remote Event Log' 'ok' ("Đọc được sự kiện ID {0}." -f $item.Id)
    }
    else {
        Add-DiagnosticTest $tests 'Remote Event Log' 'warning' $(if ($eventLog.Error) { $eventLog.Error } else { 'Không đọc được Event Log.' })
    }

    $okCount = @($tests | Where-Object Status -eq 'ok').Count
    $failCount = @($tests | Where-Object Status -eq 'fail').Count
    $warningCount = @($tests | Where-Object Status -eq 'warning').Count

    [pscustomobject]@{
        Success      = ($failCount -eq 0)
        Computer     = $Computer
        OkCount      = $okCount
        FailCount    = $failCount
        WarningCount = $warningCount
        Tests        = @($tests)
    }
}



function Test-SafeComputerName {
    param([string]$Computer)

    return (
        -not [string]::IsNullOrWhiteSpace($Computer) -and
        $Computer -match '^[A-Za-z0-9._-]{1,255}$'
    )
}

function Test-SafeServiceName {
    param([string]$ServiceName)

    return (
        -not [string]::IsNullOrWhiteSpace($ServiceName) -and
        $ServiceName -match '^[A-Za-z0-9_.$-]{1,256}$'
    )
}

function Get-ComputerServices {
    param([string]$Computer)

    $result = [ordered]@{
        Success   = $false
        Computer  = $Computer
        Services  = @()
        Count     = 0
        Running   = 0
        Stopped   = 0
        Error     = ''
        Diagnosis = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        $result.Diagnosis = 'Chỉ chấp nhận chữ, số, dấu chấm, gạch ngang và gạch dưới.'
        return [pscustomobject]$result
    }

    try {
        $session = $null
        try {
            $session = New-DomainManagerCimSession $Computer

            $items = @(
                Get-CimInstance `
                    -CimSession $session `
                    -ClassName Win32_Service `
                    -OperationTimeoutSec 12 `
                    -ErrorAction Stop |
                Select-Object `
                    Name,
                    DisplayName,
                    State,
                    StartMode,
                    StartName,
                    ProcessId,
                    PathName,
                    Description
            )

            $result.Services = @(
                $items |
                Sort-Object DisplayName, Name |
                ForEach-Object {
                    [pscustomobject]@{
                        Name        = [string]$_.Name
                        DisplayName = [string]$_.DisplayName
                        State       = [string]$_.State
                        StartMode   = [string]$_.StartMode
                        StartName   = [string]$_.StartName
                        ProcessId   = [int]$_.ProcessId
                        PathName    = [string]$_.PathName
                        Description = [string]$_.Description
                    }
                }
            )

            $result.Count = $result.Services.Count
            $result.Running = @($result.Services | Where-Object { $_.State -eq 'Running' }).Count
            $result.Stopped = @($result.Services | Where-Object { $_.State -eq 'Stopped' }).Count
            $result.Success = $true
            $result.Diagnosis = 'Đã tải danh sách dịch vụ qua CIM/DCOM.'
        } finally {
            if ($session) {
                Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }

    return [pscustomobject]$result
}

function Invoke-ComputerServiceAction {
    param(
        [string]$Computer,
        [string]$ServiceName,
        [string]$Action
    )

    $normalizedAction = $Action.Trim().ToLowerInvariant()
    $result = [ordered]@{
        Success     = $false
        Computer    = $Computer
        ServiceName = $ServiceName
        Action      = $normalizedAction
        State       = ''
        ReturnValue = $null
        Error       = ''
        Diagnosis   = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    if (-not (Test-SafeServiceName $ServiceName)) {
        $result.Error = 'Tên dịch vụ không hợp lệ.'
        return [pscustomobject]$result
    }

    if ($normalizedAction -notin @('start', 'stop', 'restart')) {
        $result.Error = 'Thao tác không được hỗ trợ.'
        return [pscustomobject]$result
    }

    try {
        $session = $null
        try {
            $session = New-DomainManagerCimSession $Computer
            $escapedName = $ServiceName.Replace("'", "''")

            $service = Get-CimInstance `
                -CimSession $session `
                -ClassName Win32_Service `
                -Filter ("Name='{0}'" -f $escapedName) `
                -OperationTimeoutSec 10 `
                -ErrorAction Stop |
                Select-Object -First 1

            if (-not $service) {
                throw "Không tìm thấy dịch vụ '$ServiceName' trên máy $Computer."
            }

            function Invoke-ServiceMethodInternal {
                param([string]$MethodName)

                $invokeResult = Invoke-CimMethod `
                    -CimSession $session `
                    -InputObject $service `
                    -MethodName $MethodName `
                    -ErrorAction Stop

                return [int]$invokeResult.ReturnValue
            }

            $returnCodes = @()

            switch ($normalizedAction) {
                'start' {
                    if ([string]$service.State -ne 'Running') {
                        $returnCodes += Invoke-ServiceMethodInternal 'StartService'
                    }
                }

                'stop' {
                    if ([string]$service.State -ne 'Stopped') {
                        $returnCodes += Invoke-ServiceMethodInternal 'StopService'
                    }
                }

                'restart' {
                    if ([string]$service.State -ne 'Stopped') {
                        $returnCodes += Invoke-ServiceMethodInternal 'StopService'

                        $stopDeadline = (Get-Date).AddSeconds(15)
                        do {
                            Start-Sleep -Milliseconds 500
                            $service = Get-CimInstance `
                                -CimSession $session `
                                -ClassName Win32_Service `
                                -Filter ("Name='{0}'" -f $escapedName) `
                                -OperationTimeoutSec 5 `
                                -ErrorAction Stop |
                                Select-Object -First 1
                        } while (
                            $service -and
                            [string]$service.State -ne 'Stopped' -and
                            (Get-Date) -lt $stopDeadline
                        )

                        if ([string]$service.State -ne 'Stopped') {
                            throw 'Dịch vụ không dừng trong thời gian cho phép.'
                        }
                    }

                    $returnCodes += Invoke-ServiceMethodInternal 'StartService'
                }
            }

            Start-Sleep -Milliseconds 700
            $service = Get-CimInstance `
                -CimSession $session `
                -ClassName Win32_Service `
                -Filter ("Name='{0}'" -f $escapedName) `
                -OperationTimeoutSec 8 `
                -ErrorAction Stop |
                Select-Object -First 1

            $nonZero = @($returnCodes | Where-Object { $_ -ne 0 })
            $result.ReturnValue = if ($returnCodes.Count) {
                ($returnCodes -join ',')
            } else {
                0
            }
            $result.State = [string]$service.State

            if ($nonZero.Count -gt 0) {
                throw (
                    "Windows Service Control Manager trả về mã lỗi: {0}" -f
                    ($nonZero -join ', ')
                )
            }

            $result.Success = $true
            $result.Diagnosis = 'Thao tác dịch vụ đã hoàn tất.'
        } finally {
            if ($session) {
                Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }

    Write-ServerLog (
        if ($result.Success) { 'INFO' } else { 'WARN' }
    ) (
        "Service action computer={0} service={1} action={2} success={3} state={4} error={5}" -f
        $Computer,
        $ServiceName,
        $normalizedAction,
        $result.Success,
        $result.State,
        $result.Error
    )

    return [pscustomobject]$result
}


function Get-ComputerProcesses {
    param([string]$Computer)

    $result = [ordered]@{
        Success       = $false
        Computer      = $Computer
        Processes     = @()
        Count         = 0
        TotalMemoryMB = 0
        Error         = ''
        Diagnosis     = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    try {
        $session = $null
        try {
            $session = New-DomainManagerCimSession $Computer

            $processes = @(
                Get-CimInstance `
                    -CimSession $session `
                    -ClassName Win32_Process `
                    -OperationTimeoutSec 15 `
                    -ErrorAction Stop |
                Select-Object `
                    Name,
                    ProcessId,
                    ParentProcessId,
                    WorkingSetSize,
                    ThreadCount,
                    SessionId,
                    ExecutablePath,
                    CommandLine,
                    CreationDate
            )

            $perfRows = @()
            try {
                $perfRows = @(
                    Get-CimInstance `
                        -CimSession $session `
                        -ClassName Win32_PerfFormattedData_PerfProc_Process `
                        -OperationTimeoutSec 10 `
                        -ErrorAction Stop |
                    Select-Object IDProcess, PercentProcessorTime
                )
            } catch {
                Write-ServerLog 'WARN' (
                    "Process performance counters unavailable computer={0} error={1}" -f
                    $Computer,
                    $_.Exception.Message
                )
            }

            $cpuMap = @{}
            foreach ($perf in $perfRows) {
                $pidValue = [int]$perf.IDProcess
                if ($pidValue -gt 0) {
                    $cpuMap[$pidValue] = [double]$perf.PercentProcessorTime
                }
            }

            $result.Processes = @(
                $processes |
                ForEach-Object {
                    $pidValue = [int]$_.ProcessId
                    $memoryMB = if ($_.WorkingSetSize) {
                        [math]::Round(([double]$_.WorkingSetSize / 1MB), 1)
                    } else {
                        0
                    }

                    $cpuValue = 0
                    if ($cpuMap.ContainsKey($pidValue)) {
                        $cpuValue = [math]::Round([double]$cpuMap[$pidValue], 1)
                    }

                    [pscustomobject]@{
                        Name            = [string]$_.Name
                        ProcessId       = $pidValue
                        ParentProcessId = [int]$_.ParentProcessId
                        CPUPercent      = $cpuValue
                        MemoryMB        = $memoryMB
                        ThreadCount     = [int]$_.ThreadCount
                        SessionId       = [int]$_.SessionId
                        ExecutablePath  = [string]$_.ExecutablePath
                        CommandLine     = [string]$_.CommandLine
                        CreationDate    = if ($_.CreationDate) {
                            try {
                                ([datetime]$_.CreationDate).ToString('yyyy-MM-dd HH:mm:ss')
                            } catch {
                                [string]$_.CreationDate
                            }
                        } else {
                            ''
                        }
                    }
                } |
                Sort-Object `
                    @{ Expression = 'MemoryMB'; Descending = $true },
                    @{ Expression = 'Name'; Descending = $false }
            )

            $result.Count = $result.Processes.Count
            $result.TotalMemoryMB = [math]::Round(
                (
                    $result.Processes |
                    Measure-Object -Property MemoryMB -Sum
                ).Sum,
                1
            )
            $result.Success = $true
            $result.Diagnosis = 'Đã tải danh sách tiến trình qua CIM/DCOM.'
        } finally {
            if ($session) {
                Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }

    return [pscustomobject]$result
}

function Stop-ComputerProcess {
    param(
        [string]$Computer,
        [int]$ProcessId
    )

    $result = [ordered]@{
        Success     = $false
        Computer    = $Computer
        ProcessId   = $ProcessId
        ProcessName = ''
        ReturnValue = $null
        Error       = ''
        Diagnosis   = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    if ($ProcessId -le 4) {
        $result.Error = 'Không cho phép kết thúc tiến trình hệ thống có PID từ 0 đến 4.'
        return [pscustomobject]$result
    }

    try {
        $session = $null
        try {
            $session = New-DomainManagerCimSession $Computer

            $process = Get-CimInstance `
                -CimSession $session `
                -ClassName Win32_Process `
                -Filter ("ProcessId={0}" -f $ProcessId) `
                -OperationTimeoutSec 10 `
                -ErrorAction Stop |
                Select-Object -First 1

            if (-not $process) {
                throw "Không tìm thấy tiến trình PID $ProcessId trên máy $Computer."
            }

            $result.ProcessName = [string]$process.Name

            $protectedNames = @(
                'system',
                'system idle process',
                'registry',
                'smss.exe',
                'csrss.exe',
                'wininit.exe',
                'winlogon.exe',
                'services.exe',
                'lsass.exe'
            )

            if ($protectedNames -contains $result.ProcessName.ToLowerInvariant()) {
                throw (
                    "Tiến trình {0} được DomainManager bảo vệ và không thể kết thúc." -f
                    $result.ProcessName
                )
            }

            $terminateResult = Invoke-CimMethod `
                -CimSession $session `
                -InputObject $process `
                -MethodName Terminate `
                -Arguments @{ Reason = 1 } `
                -ErrorAction Stop

            $result.ReturnValue = [int]$terminateResult.ReturnValue

            if ($result.ReturnValue -ne 0) {
                throw (
                    "Win32_Process.Terminate trả về mã lỗi {0}." -f
                    $result.ReturnValue
                )
            }

            $result.Success = $true
            $result.Diagnosis = 'Tiến trình đã được kết thúc.'
        } finally {
            if ($session) {
                Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }

    Write-ServerLog (
        if ($result.Success) { 'INFO' } else { 'WARN' }
    ) (
        "Process terminate computer={0} pid={1} name={2} success={3} error={4}" -f
        $Computer,
        $ProcessId,
        $result.ProcessName,
        $result.Success,
        $result.Error
    )

    return [pscustomobject]$result
}


function Convert-SoftwareInstallDate {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $Value = $Value.Trim()
    if ($Value -match '^\d{8}$') {
        try {
            return [datetime]::ParseExact(
                $Value, 'yyyyMMdd',
                [Globalization.CultureInfo]::InvariantCulture
            ).ToString('yyyy-MM-dd')
        } catch { }
    }
    return $Value
}

function Get-RegistrySoftwareString {
    param(
        [Microsoft.Management.Infrastructure.CimSession]$Session,
        [uint32]$Hive,
        [string]$Key,
        [string]$Name
    )
    try {
        $r = Invoke-CimMethod -CimSession $Session `
            -Namespace 'root/default' -ClassName StdRegProv `
            -MethodName GetStringValue `
            -Arguments @{
                hDefKey = $Hive
                sSubKeyName = $Key
                sValueName = $Name
            } -ErrorAction Stop
        if ([int]$r.ReturnValue -eq 0) { return [string]$r.sValue }
    } catch { }
    return ''
}

function Get-ComputerInstalledSoftware {
    param([string]$Computer)

    $result = [ordered]@{
        Success = $false
        Computer = $Computer
        Software = @()
        Count = 0
        Publishers = 0
        Error = ''
        Diagnosis = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    $HKLM = [uint32]2147483650
    $roots = @(
        @{ Path='SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; Architecture='64-bit' },
        @{ Path='SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'; Architecture='32-bit' }
    )

    try {
        $session = $null
        try {
            $session = New-DomainManagerCimSession $Computer
            $items = @()

            foreach ($root in $roots) {
                $enum = Invoke-CimMethod -CimSession $session `
                    -Namespace 'root/default' -ClassName StdRegProv `
                    -MethodName EnumKey `
                    -Arguments @{ hDefKey=$HKLM; sSubKeyName=$root.Path } `
                    -ErrorAction Stop

                if ([int]$enum.ReturnValue -ne 0) { continue }

                foreach ($sub in @($enum.sNames)) {
                    if ([string]::IsNullOrWhiteSpace([string]$sub)) { continue }
                    $key = '{0}\{1}' -f $root.Path, $sub
                    $name = Get-RegistrySoftwareString $session $HKLM $key 'DisplayName'
                    if ([string]::IsNullOrWhiteSpace($name)) { continue }

                    $systemComponent = Get-RegistrySoftwareString $session $HKLM $key 'SystemComponent'
                    $releaseType = Get-RegistrySoftwareString $session $HKLM $key 'ReleaseType'
                    $parentKey = Get-RegistrySoftwareString $session $HKLM $key 'ParentKeyName'

                    if (
                        $systemComponent -eq '1' -or
                        -not [string]::IsNullOrWhiteSpace($parentKey) -or
                        $releaseType -match 'Update|Hotfix|Security Update'
                    ) { continue }

                    $items += [pscustomobject]@{
                        Name = $name.Trim()
                        Version = (Get-RegistrySoftwareString $session $HKLM $key 'DisplayVersion').Trim()
                        Publisher = (Get-RegistrySoftwareString $session $HKLM $key 'Publisher').Trim()
                        InstallDate = Convert-SoftwareInstallDate (
                            Get-RegistrySoftwareString $session $HKLM $key 'InstallDate'
                        )
                        InstallLocation = (Get-RegistrySoftwareString $session $HKLM $key 'InstallLocation').Trim()
                        Architecture = $root.Architecture
                    }
                }
            }

            $software = @(
                $items |
                Group-Object {
                    '{0}|{1}|{2}' -f
                    $_.Name.ToLowerInvariant(),
                    $_.Version.ToLowerInvariant(),
                    $_.Publisher.ToLowerInvariant()
                } |
                ForEach-Object {
                    $_.Group |
                    Sort-Object @{Expression={ if ($_.Architecture -eq '64-bit') {0} else {1} }} |
                    Select-Object -First 1
                } |
                Sort-Object Name, Version
            )

            $result.Software = $software
            $result.Count = $software.Count
            $result.Publishers = @(
                $software |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_.Publisher) } |
                Select-Object -ExpandProperty Publisher -Unique
            ).Count
            $result.Success = $true
            $result.Diagnosis = 'Đã đọc Registry Uninstall 64-bit và 32-bit.'
        } finally {
            if ($session) {
                Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }

    return [pscustomobject]$result
}


function Test-SafeEventLogName {
    param([string]$LogName)
    return @('System', 'Application', 'Security') -contains $LogName
}

function Get-EventLevelName {
    param([int]$Level)

    switch ($Level) {
        1 { return 'Critical' }
        2 { return 'Error' }
        3 { return 'Warning' }
        4 { return 'Information' }
        5 { return 'Verbose' }
        default { return 'Unknown' }
    }
}

function Get-ComputerEventLog {
    param(
        [string]$Computer,
        [string]$LogName = 'System',
        [int]$Hours = 24,
        [int[]]$Levels = @(1, 2, 3, 4),
        [int]$MaxEvents = 300
    )

    $result = [ordered]@{
        Success = $false
        Computer = $Computer
        LogName = $LogName
        Hours = $Hours
        Events = @()
        Count = 0
        Critical = 0
        ErrorCount = 0
        Warning = 0
        Information = 0
        Error = ''
        Diagnosis = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    if (-not (Test-SafeEventLogName $LogName)) {
        $result.Error = 'Event Log không được hỗ trợ.'
        return [pscustomobject]$result
    }

    if ($Hours -notin @(24, 168, 720)) {
        $Hours = 24
    }

    if ($MaxEvents -lt 1 -or $MaxEvents -gt 1000) {
        $MaxEvents = 300
    }

    $safeLevels = @(
        $Levels |
        Where-Object { $_ -in @(1, 2, 3, 4) } |
        Select-Object -Unique
    )

    if (-not $safeLevels.Count) {
        $safeLevels = @(1, 2, 3, 4)
    }

    try {
        $startTime = (Get-Date).AddHours(-$Hours)
        $filter = @{
            LogName = $LogName
            StartTime = $startTime
            Level = $safeLevels
        }

        $rawEvents = @(
            Get-WinEvent `
                -ComputerName $Computer `
                -FilterHashtable $filter `
                -MaxEvents $MaxEvents `
                -ErrorAction Stop
        )

        $events = @(
            $rawEvents |
            ForEach-Object {
                $message = ''
                try {
                    $message = [string]$_.Message
                } catch {
                    $message = ''
                }

                if ([string]::IsNullOrWhiteSpace($message)) {
                    $message = '(Không có nội dung mô tả hoặc không tải được message resource.)'
                }

                [pscustomobject]@{
                    RecordId = [long]$_.RecordId
                    TimeCreated = if ($_.TimeCreated) {
                        $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
                    } else {
                        ''
                    }
                    Level = [int]$_.Level
                    LevelName = Get-EventLevelName ([int]$_.Level)
                    Id = [int]$_.Id
                    ProviderName = [string]$_.ProviderName
                    MachineName = [string]$_.MachineName
                    UserId = if ($_.UserId) { [string]$_.UserId.Value } else { '' }
                    TaskDisplayName = [string]$_.TaskDisplayName
                    OpcodeDisplayName = [string]$_.OpcodeDisplayName
                    KeywordsDisplayNames = @($_.KeywordsDisplayNames)
                    Message = $message.Trim()
                }
            }
        )

        $result.Events = $events
        $result.Count = $events.Count
        $result.Critical = @($events | Where-Object Level -eq 1).Count
        $result.ErrorCount = @($events | Where-Object Level -eq 2).Count
        $result.Warning = @($events | Where-Object Level -eq 3).Count
        $result.Information = @($events | Where-Object Level -eq 4).Count
        $result.Success = $true
        $result.Diagnosis = "Đã đọc Event Log $LogName trong $Hours giờ gần nhất."
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error

        if ($LogName -eq 'Security') {
            $result.Diagnosis += ' Security Log yêu cầu tài khoản có quyền đọc nhật ký bảo mật.'
        }
    }

    return [pscustomobject]$result
}


function Test-RemoteTcpPort {
    param(
        [string]$Computer,
        [int]$Port,
        [int]$TimeoutMs = 900
    )

    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($Computer, $Port)
        if (-not $task.Wait($TimeoutMs)) {
            return $false
        }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-RemoteToolStatus {
    param([string]$Computer)

    $result = [ordered]@{
        Success = $false
        Computer = $Computer
        Online = $false
        ResponseMs = $null
        SMB = $false
        RPC = $false
        WinRM = $false
        WMI = $false
        LoggedOnUser = ''
        OperatingSystem = ''
        Error = ''
        Diagnosis = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    try {
        $ping = New-Object Net.NetworkInformation.Ping
        try {
            $reply = $ping.Send($Computer, 1200)
            if ($reply.Status -eq [Net.NetworkInformation.IPStatus]::Success) {
                $result.Online = $true
                $result.ResponseMs = [int]$reply.RoundtripTime
            }
        } finally {
            $ping.Dispose()
        }

        $result.SMB = Test-RemoteTcpPort $Computer 445
        $result.RPC = Test-RemoteTcpPort $Computer 135
        $result.WinRM = (Test-RemoteTcpPort $Computer 5985) -or (Test-RemoteTcpPort $Computer 5986)

        try {
            $os = Get-CimInstance Win32_OperatingSystem -ComputerName $Computer -ErrorAction Stop
            $cs = Get-CimInstance Win32_ComputerSystem -ComputerName $Computer -ErrorAction Stop
            $result.WMI = $true
            $result.LoggedOnUser = [string]$cs.UserName
            $result.OperatingSystem = [string]$os.Caption
        } catch {
            $result.WMI = $false
        }

        $result.Success = $true
        $result.Diagnosis = if ($result.Online) {
            'Máy đang online. Các dịch vụ từ xa được kiểm tra riêng theo từng giao thức.'
        } else {
            'Không nhận được phản hồi ping. Máy vẫn có thể truy cập được nếu ICMP bị chặn.'
        }
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }

    return [pscustomobject]$result
}

function Convert-QuserLine {
    param([string]$Line)

    $clean = $Line.Trim()
    if (-not $clean -or $clean -match 'USERNAME\s+SESSIONNAME') {
        return $null
    }

    $activeMarker = $clean.StartsWith('>')
    $clean = $clean.TrimStart('>').Trim()
    $parts = @($clean -split '\s{2,}' | Where-Object { $_ -ne '' })

    if ($parts.Count -lt 3) {
        return $null
    }

    $username = [string]$parts[0]
    $sessionName = ''
    $sessionId = $null
    $state = ''
    $idle = ''
    $logonTime = ''

    if ($parts[1] -match '^\d+$') {
        $sessionId = [int]$parts[1]
        $state = [string]$parts[2]
        if ($parts.Count -gt 3) { $idle = [string]$parts[3] }
        if ($parts.Count -gt 4) { $logonTime = [string]$parts[4] }
    } else {
        $sessionName = [string]$parts[1]
        if ($parts.Count -gt 2 -and $parts[2] -match '^\d+$') {
            $sessionId = [int]$parts[2]
        }
        if ($parts.Count -gt 3) { $state = [string]$parts[3] }
        if ($parts.Count -gt 4) { $idle = [string]$parts[4] }
        if ($parts.Count -gt 5) { $logonTime = [string]$parts[5] }
    }

    if ($null -eq $sessionId) {
        return $null
    }

    return [pscustomobject]@{
        UserName = $username
        SessionName = $sessionName
        SessionId = $sessionId
        State = $state
        IdleTime = $idle
        LogonTime = $logonTime
        Current = $activeMarker
    }
}

function Get-RemoteSessions {
    param([string]$Computer)

    $result = [ordered]@{
        Success = $false
        Computer = $Computer
        Sessions = @()
        Count = 0
        Error = ''
        Diagnosis = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    try {
        $output = & quser.exe "/server:$Computer" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw (($output | Out-String).Trim())
        }

        $sessions = @(
            $output |
            ForEach-Object { Convert-QuserLine ([string]$_) } |
            Where-Object { $_ }
        )

        $result.Sessions = $sessions
        $result.Count = $sessions.Count
        $result.Success = $true
        $result.Diagnosis = 'Đã đọc danh sách phiên đăng nhập.'
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = 'Không đọc được session. Kiểm tra quyền quản trị, RPC và Remote Desktop Services.'
    }

    return [pscustomobject]$result
}

function Get-RemotePrinters {
    param([string]$Computer)

    $result = [ordered]@{
        Success = $false
        Computer = $Computer
        Printers = @()
        Count = 0
        DefaultCount = 0
        Error = ''
        Diagnosis = ''
    }

    if (-not (Test-SafeComputerName $Computer)) {
        $result.Error = 'Tên máy tính không hợp lệ.'
        return [pscustomobject]$result
    }

    try {
        $printers = @(
            Get-CimInstance Win32_Printer -ComputerName $Computer -ErrorAction Stop |
            Sort-Object @{ Expression = 'Default'; Descending = $true }, Name |
            ForEach-Object {
                [pscustomobject]@{
                    Name = [string]$_.Name
                    DriverName = [string]$_.DriverName
                    PortName = [string]$_.PortName
                    Default = [bool]$_.Default
                    Network = [bool]$_.Network
                    Shared = [bool]$_.Shared
                    ShareName = [string]$_.ShareName
                    Status = [string]$_.Status
                    WorkOffline = [bool]$_.WorkOffline
                }
            }
        )

        $result.Printers = $printers
        $result.Count = $printers.Count
        $result.DefaultCount = @($printers | Where-Object Default).Count
        $result.Success = $true
        $result.Diagnosis = 'Đã đọc danh sách máy in.'
    } catch {
        $result.Error = $_.Exception.Message
        $result.Diagnosis = Get-ErrorDiagnosis $result.Error
    }

    return [pscustomobject]$result
}

function Invoke-RemotePowerAction {
    param(
        [string]$Computer,
        [string]$Action,
        [int]$DelaySeconds = 30,
        [string]$Comment = 'Thao tác từ DomainManager'
    )

    if (-not (Test-SafeComputerName $Computer)) {
        throw 'Tên máy tính không hợp lệ.'
    }

    if ($Action -notin @('restart', 'shutdown', 'abort')) {
        throw 'Thao tác nguồn không hợp lệ.'
    }

    if ($DelaySeconds -lt 0 -or $DelaySeconds -gt 3600) {
        $DelaySeconds = 30
    }

    $safeComment = ($Comment -replace '[\r\n"]', ' ').Trim()
    if ($safeComment.Length -gt 120) {
        $safeComment = $safeComment.Substring(0, 120)
    }

    $arguments = @('/m', "\\$Computer")
    switch ($Action) {
        'restart' {
            $arguments += @('/r', '/t', [string]$DelaySeconds, '/f', '/c', $safeComment)
        }
        'shutdown' {
            $arguments += @('/s', '/t', [string]$DelaySeconds, '/f', '/c', $safeComment)
        }
        'abort' {
            $arguments += '/a'
        }
    }

    $output = & shutdown.exe @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | Out-String).Trim())
    }

    return [pscustomobject]@{
        Success = $true
        Computer = $Computer
        Action = $Action
        DelaySeconds = $DelaySeconds
        Message = if ($Action -eq 'abort') {
            'Đã gửi lệnh hủy shutdown/restart.'
        } else {
            "Đã gửi lệnh $Action, thời gian chờ $DelaySeconds giây."
        }
    }
}

function Invoke-RemoteSessionAction {
    param(
        [string]$Computer,
        [int]$SessionId,
        [string]$Action
    )

    if (-not (Test-SafeComputerName $Computer)) {
        throw 'Tên máy tính không hợp lệ.'
    }

    if ($SessionId -lt 0 -or $SessionId -gt 999999) {
        throw 'Session ID không hợp lệ.'
    }

    if ($Action -ne 'logoff') {
        throw 'Thao tác session không hợp lệ.'
    }

    $output = & logoff.exe $SessionId "/server:$Computer" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | Out-String).Trim())
    }

    return [pscustomobject]@{
        Success = $true
        Computer = $Computer
        SessionId = $SessionId
        Action = $Action
        Message = "Đã gửi lệnh logoff Session $SessionId."
    }
}

function Send-RemoteMessage {
    param(
        [string]$Computer,
        [string]$Message,
        [int]$SessionId = -1,
        [int]$TimeoutSeconds = 60
    )

    if (-not (Test-SafeComputerName $Computer)) {
        throw 'Tên máy tính không hợp lệ.'
    }

    $safeMessage = ($Message -replace '[\r\n]+', ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($safeMessage)) {
        throw 'Nội dung thông báo đang trống.'
    }

    if ($safeMessage.Length -gt 500) {
        $safeMessage = $safeMessage.Substring(0, 500)
    }

    if ($TimeoutSeconds -lt 5 -or $TimeoutSeconds -gt 3600) {
        $TimeoutSeconds = 60
    }

    $target = if ($SessionId -ge 0) { [string]$SessionId } else { '*' }
    $output = & msg.exe $target "/server:$Computer" "/time:$TimeoutSeconds" $safeMessage 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | Out-String).Trim())
    }

    return [pscustomobject]@{
        Success = $true
        Computer = $Computer
        SessionId = $SessionId
        Message = 'Đã gửi thông báo tới máy đích.'
    }
}

function Open-RemoteLocalTool {
    param(
        [string]$Computer,
        [string]$Tool
    )

    if (-not (Test-SafeComputerName $Computer)) {
        throw 'Tên máy tính không hợp lệ.'
    }

    switch ($Tool) {
        'rdp' {
            Start-Process 'mstsc.exe' -ArgumentList "/v:$Computer"
        }
        'cshare' {
            Start-Process 'explorer.exe' -ArgumentList "\\$Computer\C$"
        }
        'adminshare' {
            Start-Process 'explorer.exe' -ArgumentList "\\$Computer\ADMIN$"
        }
        default {
            throw 'Công cụ local không hợp lệ.'
        }
    }

    return [pscustomobject]@{
        Success = $true
        Computer = $Computer
        Tool = $Tool
        Message = "Đã mở $Tool trên máy đang chạy DomainManager."
    }
}

function Get-ContentType {
    param([string]$Extension)

    switch ($Extension.ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.js'   { 'application/javascript; charset=utf-8' }
        '.ico'  { 'image/x-icon' }
        '.png'  { 'image/png' }
        default { 'application/octet-stream' }
    }
}

try {
    Start-Process $Address
} catch {}


function Get-AdComputerJson {
    param([bool]$ForceRefresh = $false)

    $now = Get-Date
    $ageSeconds = if ($script:AdCacheCreated -eq [datetime]::MinValue) {
        [double]::PositiveInfinity
    } else {
        ($now - $script:AdCacheCreated).TotalSeconds
    }

    if (
        -not $ForceRefresh -and
        $script:AdCacheJson -and
        $ageSeconds -lt $AdCacheTtlSeconds
    ) {
        Write-ServerLog 'INFO' (
            "AD cache hit: age={0}s, ttl={1}s" -f
            [math]::Round($ageSeconds), $AdCacheTtlSeconds
        )

        return [pscustomobject]@{
            Json = $script:AdCacheJson
            Cache = 'HIT'
            AgeSeconds = [math]::Round($ageSeconds)
        }
    }

    Write-ServerLog 'INFO' (
        "AD cache refresh bắt đầu: force={0}" -f $ForceRefresh
    )

    $started = Get-Date
    $json = & (Join-Path $Root 'api.ps1')
    if ($json -is [array]) {
        $json = $json -join ''
    }

    $script:AdCacheJson = [string]$json
    $script:AdCacheCreated = Get-Date
    $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)

    Write-ServerLog 'INFO' (
        "AD cache refresh hoàn tất: {0} ms, {1} bytes" -f
        $elapsed, ([Text.Encoding]::UTF8.GetByteCount($script:AdCacheJson))
    )

    return [pscustomobject]@{
        Json = $script:AdCacheJson
        Cache = 'MISS'
        AgeSeconds = 0
    }
}


# ==========================================================
# V11.0 - ACTIVE DIRECTORY USER MANAGER
# ==========================================================
function ConvertTo-LdapFilterValue {
    param([string]$Value)
    if ($null -eq $Value) { return '' }
    return $Value.Replace('\\', '\5c').Replace('*', '\2a').Replace('(', '\28').Replace(')', '\29').Replace(([char]0).ToString(), '\00')
}

function Convert-FileTimeValue {
    param($Value)
    try {
        if ($null -eq $Value) { return $null }
        $ticks = [int64]$Value
        if ($ticks -le 0 -or $ticks -eq [int64]::MaxValue) { return $null }
        return [datetime]::FromFileTimeUtc($ticks).ToLocalTime().ToString('o')
    } catch { return $null }
}

function Get-AdDefaultNamingContext {
    $rootDse = New-Object DirectoryServices.DirectoryEntry('LDAP://RootDSE')
    try { return [string]$rootDse.Properties['defaultNamingContext'][0] }
    finally { $rootDse.Dispose() }
}

function Get-AdUsers {
    param([string]$Search = '', [int]$Limit = 500)
    $entry = $null; $searcher = $null; $results = $null
    try {
        if ($Limit -lt 1) { $Limit = 100 }
        if ($Limit -gt 2000) { $Limit = 2000 }
        $base = Get-AdDefaultNamingContext
        $entry = New-Object DirectoryServices.DirectoryEntry("LDAP://$base")
        $searcher = New-Object DirectoryServices.DirectorySearcher($entry)
        $searcher.PageSize = 500
        $searcher.SizeLimit = $Limit
        $searcher.SearchScope = [DirectoryServices.SearchScope]::Subtree
        $term = ConvertTo-LdapFilterValue $Search.Trim()
        if ([string]::IsNullOrWhiteSpace($term)) {
            $searcher.Filter = '(&(objectCategory=person)(objectClass=user))'
        } else {
            $searcher.Filter = "(&(objectCategory=person)(objectClass=user)(|(samAccountName=*$term*)(displayName=*$term*)(mail=*$term*)(userPrincipalName=*$term*)))"
        }
        foreach ($name in @('samAccountName','displayName','mail','userPrincipalName','department','title','distinguishedName','userAccountControl','lockoutTime','lastLogonTimestamp','pwdLastSet','whenCreated','telephoneNumber','mobile','physicalDeliveryOfficeName','company','manager','description')) { [void]$searcher.PropertiesToLoad.Add($name) }
        $results = $searcher.FindAll()
        $users = foreach ($result in $results) {
            $props = $result.Properties
            $uac = if ($props['useraccountcontrol'].Count) { [int]$props['useraccountcontrol'][0] } else { 0 }
            $lockout = if ($props['lockouttime'].Count) { [int64]$props['lockouttime'][0] } else { 0 }
            [pscustomobject]@{
                SamAccountName = if ($props['samaccountname'].Count) { [string]$props['samaccountname'][0] } else { '' }
                DisplayName = if ($props['displayname'].Count) { [string]$props['displayname'][0] } else { '' }
                Email = if ($props['mail'].Count) { [string]$props['mail'][0] } else { '' }
                UserPrincipalName = if ($props['userprincipalname'].Count) { [string]$props['userprincipalname'][0] } else { '' }
                Department = if ($props['department'].Count) { [string]$props['department'][0] } else { '' }
                Title = if ($props['title'].Count) { [string]$props['title'][0] } else { '' }
                Telephone = if ($props['telephonenumber'].Count) { [string]$props['telephonenumber'][0] } else { '' }
                Mobile = if ($props['mobile'].Count) { [string]$props['mobile'][0] } else { '' }
                Office = if ($props['physicaldeliveryofficename'].Count) { [string]$props['physicaldeliveryofficename'][0] } else { '' }
                Company = if ($props['company'].Count) { [string]$props['company'][0] } else { '' }
                Manager = if ($props['manager'].Count) { [string]$props['manager'][0] } else { '' }
                Description = if ($props['description'].Count) { [string]$props['description'][0] } else { '' }
                DistinguishedName = if ($props['distinguishedname'].Count) { [string]$props['distinguishedname'][0] } else { '' }
                Enabled = (($uac -band 2) -eq 0)
                Locked = ($lockout -gt 0)
                PasswordNeverExpires = (($uac -band 65536) -ne 0)
                PasswordExpired = (($uac -band 8388608) -ne 0)
                LastLogon = if ($props['lastlogontimestamp'].Count) { Convert-FileTimeValue $props['lastlogontimestamp'][0] } else { $null }
                PasswordLastSet = if ($props['pwdlastset'].Count) { Convert-FileTimeValue $props['pwdlastset'][0] } else { $null }
                Created = if ($props['whencreated'].Count) { ([datetime]$props['whencreated'][0]).ToString('o') } else { $null }
            }
        }
        return @{ Success=$true; Count=@($users).Count; Users=@($users | Sort-Object DisplayName, SamAccountName); Base=$base }
    } catch { return @{ Success=$false; Error=$_.Exception.Message; Count=0; Users=@() } }
    finally { if ($results) { $results.Dispose() }; if ($searcher) { $searcher.Dispose() }; if ($entry) { $entry.Dispose() } }
}

function Get-AdUserEntryBySam {
    param([string]$SamAccountName)
    $base = Get-AdDefaultNamingContext
    $root = New-Object DirectoryServices.DirectoryEntry("LDAP://$base")
    $searcher = New-Object DirectoryServices.DirectorySearcher($root)
    try {
        $safe = ConvertTo-LdapFilterValue $SamAccountName
        $searcher.Filter = "(&(objectCategory=person)(objectClass=user)(samAccountName=$safe))"
        $searcher.SearchScope = [DirectoryServices.SearchScope]::Subtree
        $result = $searcher.FindOne()
        if (-not $result) { throw "Không tìm thấy tài khoản '$SamAccountName'." }
        return New-Object DirectoryServices.DirectoryEntry($result.Path)
    } finally { $searcher.Dispose(); $root.Dispose() }
}



function Get-AdCurrentPermissionContext {
    param([string]$SamAccountName)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $groupNames = @()
    try {
        $groupNames = @($identity.Groups | ForEach-Object {
            try { $_.Translate([Security.Principal.NTAccount]).Value } catch { $_.Value }
        })
    } catch {}
    $roles = [ordered]@{
        DomainAdmins = [bool](@($groupNames | Where-Object { $_ -match '\\Domain Admins$' }).Count)
        EnterpriseAdmins = [bool](@($groupNames | Where-Object { $_ -match '\\Enterprise Admins$' }).Count)
        AccountOperators = [bool](@($groupNames | Where-Object { $_ -match '\\Account Operators$' }).Count)
        Administrators = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    $targetDn = ''
    if (-not [string]::IsNullOrWhiteSpace($SamAccountName)) {
        $entry = $null
        try { $entry = Get-AdUserEntryBySam $SamAccountName; $targetDn = [string]$entry.Properties['distinguishedName'].Value } catch {} finally { if ($entry) { $entry.Dispose() } }
    }
    $likelyAdmin = $roles.DomainAdmins -or $roles.EnterpriseAdmins -or $roles.AccountOperators
    return @{
        Success = $true
        Identity = $identity.Name
        AuthenticationType = $identity.AuthenticationType
        IsAuthenticated = $identity.IsAuthenticated
        Roles = $roles
        LikelyCanManageUsers = $likelyAdmin
        TargetSamAccountName = $SamAccountName
        TargetDistinguishedName = $targetDn
        Note = 'Kết quả dựa trên nhóm bảo mật hiện tại. Quyền Delegate trên OU chỉ được Active Directory xác nhận khi thực hiện thao tác.'
    }
}

function Get-AdActionDiagnosis {
    param([string]$Message,[string]$Action,[string]$TargetDn)
    if ($Message -match 'Access is denied|0x80070005|E_ACCESSDENIED') {
        return "Tài khoản chạy DomainManager không có quyền '$Action' đối với đối tượng này. Hãy chạy bằng tài khoản được Delegate quyền trên OU hoặc Domain Admin. Đích: $TargetDn"
    }
    if ($Message -match 'constraint|password|1325|0x800708C5') {
        return 'Mật khẩu không đáp ứng chính sách Domain hoặc thao tác bị ràng buộc bởi chính sách tài khoản.'
    }
    if ($Message -match 'server is unwilling|0x80072035') {
        return 'Domain Controller từ chối thao tác. Kiểm tra chính sách tài khoản, trạng thái bảo vệ và quyền trên OU.'
    }
    return 'Active Directory không thực hiện được thao tác. Kiểm tra quyền, kết nối Domain Controller và nhật ký máy chủ.'
}

function Write-AdAuditLog {
    param([string]$SamAccountName,[string]$Action,[bool]$Success,[string]$Message,[string]$TargetDn)
    try {
        $auditFile = Join-Path $Root 'AD_Audit.csv'
        $record = [pscustomobject]@{
            Time = (Get-Date).ToString('s')
            Operator = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            Target = $SamAccountName
            Action = $Action
            Success = $Success
            Message = $Message
            DistinguishedName = $TargetDn
        }
        if (Test-Path $auditFile) { $record | Export-Csv -Path $auditFile -Append -NoTypeInformation -Encoding UTF8 }
        else { $record | Export-Csv -Path $auditFile -NoTypeInformation -Encoding UTF8 }
    } catch { Write-ServerLog 'ERROR' ("Cannot write AD audit: {0}" -f $_.Exception.Message) }
}

function Invoke-AdUserAction {
    param([string]$SamAccountName,[string]$Action,[string]$Password,[bool]$MustChangePassword=$true)
    $user = $null; $targetDn = ''
    try {
        if ([string]::IsNullOrWhiteSpace($SamAccountName)) { throw 'Thiếu tên đăng nhập.' }
        $user = Get-AdUserEntryBySam $SamAccountName
        $targetDn = [string]$user.Properties['distinguishedName'].Value
        switch ($Action.ToLowerInvariant()) {
            'enable' { $uac=[int]$user.Properties['userAccountControl'].Value; $user.Properties['userAccountControl'].Value=($uac -band (-bnot 2)); $user.CommitChanges(); $message='Đã kích hoạt tài khoản.' }
            'disable' { $uac=[int]$user.Properties['userAccountControl'].Value; $user.Properties['userAccountControl'].Value=($uac -bor 2); $user.CommitChanges(); $message='Đã vô hiệu hóa tài khoản.' }
            'unlock' { $user.Invoke('UnlockAccount'); $user.CommitChanges(); $message='Đã mở khóa tài khoản.' }
            'reset-password' {
                if ([string]::IsNullOrWhiteSpace($Password) -or $Password.Length -lt 8) { throw 'Mật khẩu mới phải có ít nhất 8 ký tự.' }
                $user.Invoke('SetPassword', @($Password))
                if ($MustChangePassword) { $user.Properties['pwdLastSet'].Value = 0 } else { $user.Properties['pwdLastSet'].Value = -1 }
                $user.CommitChanges(); $message='Đã đặt lại mật khẩu.'
            }
            default { throw 'Thao tác không hợp lệ.' }
        }
        Write-AdAuditLog $SamAccountName $Action $true $message $targetDn
        Write-ServerLog 'WARN' ("AD user action sam={0} action={1} success=True" -f $SamAccountName,$Action)
        return @{ Success=$true; Message=$message; SamAccountName=$SamAccountName; Action=$Action; Operator=[Security.Principal.WindowsIdentity]::GetCurrent().Name }
    } catch {
        $raw = $_.Exception.Message
        $diagnosis = Get-AdActionDiagnosis $raw $Action $targetDn
        Write-AdAuditLog $SamAccountName $Action $false $raw $targetDn
        Write-ServerLog 'ERROR' ("AD user action sam={0} action={1} error={2}" -f $SamAccountName,$Action,$raw)
        return @{ Success=$false; Error=$raw; Diagnosis=$diagnosis; ErrorCode=if($raw -match 'Access is denied|0x80070005'){ 'ACCESS_DENIED' }else{'AD_ACTION_FAILED'}; Operator=[Security.Principal.WindowsIdentity]::GetCurrent().Name; TargetDistinguishedName=$targetDn }
    } finally { if ($user) { $user.Dispose() } }
}

while ($listener.IsListening) {
    $response = $null

    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $path = $request.Url.AbsolutePath.ToLowerInvariant()
        Write-ServerLog 'INFO' ("{0} {1}" -f $request.HttpMethod, $path)
        if ($path -eq '/') { $path = '/index.html' }

        # Route hệ thống xử lý trước router chính.
        if ($path -eq '/version' -or $path -eq '/health') {
            Send-Json $response @{
                Success = $true
                Version = $BuildVersion
                BuildId = $BuildId
                Address = $Address
                Root = $Root
                ProcessId = $PID
                LogFile = $LogFile
            }
            continue
        }

        if ($path -eq '/server/log') {
            try {
                $lines = if (Test-Path $LogFile) {
                    @(Get-Content -Path $LogFile -Tail 200 -ErrorAction Stop)
                } else {
                    @('Chưa có log.')
                }
                Send-Json $response @{
                    Success = $true
                    Version = $BuildVersion
                    LogFile = $LogFile
                    Lines = $lines
                }
            } catch {
                Send-Json $response @{ Success = $false; Error = $_.Exception.Message } 500
            }
            continue
        }

        if ($path -in @('/index.html', '/style.css', '/app.js')) {
            $file = Join-Path $Root $path.TrimStart('/')

            if (-not (Test-Path $file)) {
                Send-Text $response '404' 'text/plain; charset=utf-8' 404
                continue
            }

            $bytes = [IO.File]::ReadAllBytes($file)
            $response.ContentType = Get-ContentType ([IO.Path]::GetExtension($file))
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            continue
        }

        switch ($path) {
            '/api' {
                $forceRefresh = (
                    [string]$request.QueryString['refresh'] -eq '1'
                )

                $cached = Get-AdComputerJson -ForceRefresh $forceRefresh

                $response.Headers['X-DomainManager-Cache'] = $cached.Cache
                $response.Headers['X-DomainManager-Cache-Age'] = [string]$cached.AgeSeconds
                Send-Text $response $cached.Json 'application/json; charset=utf-8'
            }

            '/api/cache' {
                $ageSeconds = if ($script:AdCacheCreated -eq [datetime]::MinValue) {
                    $null
                } else {
                    [math]::Round(((Get-Date) - $script:AdCacheCreated).TotalSeconds)
                }

                Send-Json $response @{
                    Success = $true
                    HasCache = [bool]$script:AdCacheJson
                    Created = if ($script:AdCacheCreated -eq [datetime]::MinValue) {
                        $null
                    } else {
                        $script:AdCacheCreated.ToString('o')
                    }
                    AgeSeconds = $ageSeconds
                    TtlSeconds = $AdCacheTtlSeconds
                }
            }

            '/pingbatch' {
                $body = Read-Body $request
                $names = @(
                    $body.names |
                    ForEach-Object { [string]$_ } |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
                )

                Write-ServerLog 'INFO' ("Ping batch bắt đầu: {0} máy" -f $names.Count)
                $started = Get-Date
                $result = @(Test-ComputerBatch $names)
                $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)

                Write-ServerLog 'INFO' (
                    "Ping batch hoàn tất: yêu cầu={0}, kết quả={1}, thời gian={2} ms" -f
                    $names.Count, $result.Count, $elapsed
                )

                Send-Json $response @{
                    Success = $true
                    Requested = $names.Count
                    Returned = $result.Count
                    ElapsedMilliseconds = $elapsed
                    Results = $result
                }
            }

            '/ad/users' {
                $body = Read-Body $request
                $search = if ($body) { [string]$body.search } else { '' }
                $limit = 500
                try { if ($body.limit) { $limit = [int]$body.limit } } catch {}
                $started = Get-Date
                $result = Get-AdUsers -Search $search -Limit $limit
                Write-ServerLog 'INFO' ("AD users search='{0}' success={1} count={2} elapsedMs={3}" -f $search,$result.Success,$result.Count,[math]::Round(((Get-Date)-$started).TotalMilliseconds))
                Send-Json $response $result
            }

            '/ad/permission' {
                $body = Read-Body $request
                $sam = if ($body) { [string]$body.samAccountName } else { '' }
                Send-Json $response (Get-AdCurrentPermissionContext -SamAccountName $sam)
            }

            '/ad/user/action' {
                $body = Read-Body $request
                $sam = [string]$body.samAccountName
                $action = [string]$body.action
                $password = [string]$body.password
                $mustChange = $true
                try { if ($null -ne $body.mustChangePassword) { $mustChange = [bool]$body.mustChangePassword } } catch {}
                $result = Invoke-AdUserAction -SamAccountName $sam -Action $action -Password $password -MustChangePassword $mustChange
                Send-Json $response $result $(if ($result.Success) { 200 } else { 400 })
            }

            '/computer/basic' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{ Success = $false; Error = 'Thiếu tên máy tính.' } 400
                    continue
                }
                Send-Json $response (Get-ComputerBasicInfo $computer)
            }

            '/computer/hardware' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{ Success = $false; Error = 'Thiếu tên máy tính.' } 400
                    continue
                }
                Send-Json $response (Get-ComputerHardwareInfo $computer)
            }

            '/computer/network' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{ Success = $false; Error = 'Thiếu tên máy tính.' } 400
                    continue
                }
                Send-Json $response (Get-ComputerNetworkInfo $computer)
            }

            '/computer/disks' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{ Success = $false; Error = 'Thiếu tên máy tính.' } 400
                    continue
                }
                Send-Json $response (Get-ComputerDiskInfo $computer)
            }

            '/computer/services' {
                $body = Read-Body $request
                $computer = [string]$body.computer

                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{
                        Success = $false
                        Error = 'Thiếu tên máy tính.'
                    } 400
                    continue
                }

                $started = Get-Date
                $serviceResult = Get-ComputerServices $computer
                $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)

                Write-ServerLog 'INFO' (
                    "Services list computer={0} success={1} count={2} elapsedMs={3}" -f
                    $computer,
                    $serviceResult.Success,
                    $serviceResult.Count,
                    $elapsed
                )

                Send-Json $response $serviceResult
            }

            '/computer/service/action' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $serviceName = [string]$body.service
                $action = [string]$body.action

                if (
                    [string]::IsNullOrWhiteSpace($computer) -or
                    [string]::IsNullOrWhiteSpace($serviceName) -or
                    [string]::IsNullOrWhiteSpace($action)
                ) {
                    Send-Json $response @{
                        Success = $false
                        Error = 'Thiếu tên máy, dịch vụ hoặc thao tác.'
                    } 400
                    continue
                }

                Send-Json $response (
                    Invoke-ComputerServiceAction `
                        -Computer $computer `
                        -ServiceName $serviceName `
                        -Action $action
                )
            }

            '/computer/processes' {
                $body = Read-Body $request
                $computer = [string]$body.computer

                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{
                        Success = $false
                        Error = 'Thiếu tên máy tính.'
                    } 400
                    continue
                }

                $started = Get-Date
                $processResult = Get-ComputerProcesses $computer
                $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)

                Write-ServerLog 'INFO' (
                    "Processes list computer={0} success={1} count={2} elapsedMs={3}" -f
                    $computer,
                    $processResult.Success,
                    $processResult.Count,
                    $elapsed
                )

                Send-Json $response $processResult
            }

            '/computer/process/terminate' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $processId = 0

                try {
                    $processId = [int]$body.processId
                } catch {
                    $processId = 0
                }

                if (
                    [string]::IsNullOrWhiteSpace($computer) -or
                    $processId -le 0
                ) {
                    Send-Json $response @{
                        Success = $false
                        Error = 'Thiếu tên máy hoặc PID hợp lệ.'
                    } 400
                    continue
                }

                Send-Json $response (
                    Stop-ComputerProcess `
                        -Computer $computer `
                        -ProcessId $processId
                )
            }


            '/computer/software' {
                $body = Read-Body $request
                $computer = [string]$body.computer

                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{
                        Success = $false
                        Error = 'Thiếu tên máy tính.'
                    } 400
                    continue
                }

                $started = Get-Date
                $softwareResult = Get-ComputerInstalledSoftware $computer
                $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)

                Write-ServerLog 'INFO' (
                    "Software list computer={0} success={1} count={2} elapsedMs={3}" -f
                    $computer,
                    $softwareResult.Success,
                    $softwareResult.Count,
                    $elapsed
                )

                Send-Json $response $softwareResult
            }


            '/computer/remote/status' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $started = Get-Date
                $result = Get-RemoteToolStatus $computer
                $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
                Write-ServerLog 'INFO' ("Remote status computer={0} success={1} online={2} elapsedMs={3}" -f $computer, $result.Success, $result.Online, $elapsed)
                Send-Json $response $result
            }

            '/computer/remote/sessions' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $result = Get-RemoteSessions $computer
                Write-ServerLog 'INFO' ("Remote sessions computer={0} success={1} count={2}" -f $computer, $result.Success, $result.Count)
                Send-Json $response $result
            }

            '/computer/remote/printers' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $result = Get-RemotePrinters $computer
                Write-ServerLog 'INFO' ("Remote printers computer={0} success={1} count={2}" -f $computer, $result.Success, $result.Count)
                Send-Json $response $result
            }

            '/computer/remote/power' {
                $body = Read-Body $request
                try {
                    $computer = [string]$body.computer
                    $action = [string]$body.action
                    $delay = 30
                    try { $delay = [int]$body.delaySeconds } catch {}
                    $comment = [string]$body.comment
                    $result = Invoke-RemotePowerAction $computer $action $delay $comment
                    Write-ServerLog 'WARN' ("Remote power computer={0} action={1} delay={2} success=True" -f $computer, $action, $delay)
                    Send-Json $response $result
                } catch {
                    Write-ServerLog 'ERROR' ("Remote power failed: {0}" -f $_.Exception.Message)
                    Send-Json $response @{ Success = $false; Error = $_.Exception.Message } 500
                }
            }

            '/computer/remote/session-action' {
                $body = Read-Body $request
                try {
                    $computer = [string]$body.computer
                    $sessionId = [int]$body.sessionId
                    $action = [string]$body.action
                    $result = Invoke-RemoteSessionAction $computer $sessionId $action
                    Write-ServerLog 'WARN' ("Remote session action computer={0} session={1} action={2} success=True" -f $computer, $sessionId, $action)
                    Send-Json $response $result
                } catch {
                    Write-ServerLog 'ERROR' ("Remote session action failed: {0}" -f $_.Exception.Message)
                    Send-Json $response @{ Success = $false; Error = $_.Exception.Message } 500
                }
            }

            '/computer/remote/message' {
                $body = Read-Body $request
                try {
                    $computer = [string]$body.computer
                    $message = [string]$body.message
                    $sessionId = -1
                    $timeout = 60
                    try { $sessionId = [int]$body.sessionId } catch {}
                    try { $timeout = [int]$body.timeoutSeconds } catch {}
                    $result = Send-RemoteMessage $computer $message $sessionId $timeout
                    Write-ServerLog 'WARN' ("Remote message computer={0} session={1} success=True length={2}" -f $computer, $sessionId, $message.Length)
                    Send-Json $response $result
                } catch {
                    Write-ServerLog 'ERROR' ("Remote message failed: {0}" -f $_.Exception.Message)
                    Send-Json $response @{ Success = $false; Error = $_.Exception.Message } 500
                }
            }

            '/computer/remote/open' {
                $body = Read-Body $request
                try {
                    $computer = [string]$body.computer
                    $tool = [string]$body.tool
                    $result = Open-RemoteLocalTool $computer $tool
                    Write-ServerLog 'INFO' ("Remote local tool computer={0} tool={1} success=True" -f $computer, $tool)
                    Send-Json $response $result
                } catch {
                    Write-ServerLog 'ERROR' ("Remote local tool failed: {0}" -f $_.Exception.Message)
                    Send-Json $response @{ Success = $false; Error = $_.Exception.Message } 500
                }
            }


            '/computer/events' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $logName = [string]$body.logName
                $hours = 24
                $maxEvents = 300
                $levels = @(1, 2, 3, 4)

                try { $hours = [int]$body.hours } catch { $hours = 24 }
                try { $maxEvents = [int]$body.maxEvents } catch { $maxEvents = 300 }

                if ($body.levels) {
                    try {
                        $levels = @($body.levels | ForEach-Object { [int]$_ })
                    } catch {
                        $levels = @(1, 2, 3, 4)
                    }
                }

                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{
                        Success = $false
                        Error = 'Thiếu tên máy tính.'
                    } 400
                    continue
                }

                if ([string]::IsNullOrWhiteSpace($logName)) {
                    $logName = 'System'
                }

                $started = Get-Date
                $eventResult = Get-ComputerEventLog `
                    -Computer $computer `
                    -LogName $logName `
                    -Hours $hours `
                    -Levels $levels `
                    -MaxEvents $maxEvents

                $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)

                Write-ServerLog 'INFO' (
                    "Event log computer={0} log={1} success={2} count={3} elapsedMs={4}" -f
                    $computer,
                    $logName,
                    $eventResult.Success,
                    $eventResult.Count,
                    $elapsed
                )

                Send-Json $response $eventResult
            }


            '/version' {
                Send-Json $response @{
                    Version = $BuildVersion
                    BuildId = $BuildId
                    Root = $Root
                    LogFile = $LogFile
                }
            }

            '/server/log' {
                try {
                    $lines = if (Test-Path $LogFile) {
                        @(Get-Content -Path $LogFile -Tail 200 -ErrorAction Stop)
                    } else {
                        @('Chưa có log.')
                    }

                    Send-Json $response @{
                        Success = $true
                        LogFile = $LogFile
                        Lines = $lines
                    }
                } catch {
                    Send-Json $response @{
                        Success = $false
                        Error = $_.Exception.Message
                    } 500
                }
            }

            '/computer/diagnostic/test' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $test = [string]$body.test

                if ([string]::IsNullOrWhiteSpace($computer) -or [string]::IsNullOrWhiteSpace($test)) {
                    Send-Json $response @{
                        Name = $test
                        Status = 'fail'
                        Detail = 'Thiếu tên máy hoặc phép thử.'
                    } 400
                    continue
                }

                $started = Get-Date
                Write-ServerLog 'INFO' ("Diagnostic start computer={0} test={1}" -f $computer, $test)

                $diagnosticResult = Get-SingleComputerDiagnostic $computer $test

                $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
                Write-ServerLog 'INFO' (
                    "Diagnostic end computer={0} test={1} status={2} elapsedMs={3} detail={4}" -f
                    $computer, $test, $diagnosticResult.Status, $elapsed, $diagnosticResult.Detail
                )

                Send-Json $response $diagnosticResult
            }

            '/computer/diagnostic' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{ Success = $false; Error = 'Thiếu tên máy tính.' } 400
                    continue
                }
                Send-Json $response (Get-ComputerDiagnostic $computer)
            }

            '/action' {
                $body = Read-Body $request
                $computer = [string]$body.computer
                $action = ([string]$body.action).ToLowerInvariant()

                if ([string]::IsNullOrWhiteSpace($computer)) {
                    Send-Json $response @{ error = 'Thieu ten may tinh.' } 400
                    continue
                }

                switch ($action) {
                    'rdp' {
                        Start-Process 'mstsc.exe' -ArgumentList "/v:$computer"
                        Send-Json $response @{ ok = $true; message = "Da mo Remote Desktop toi $computer" }
                    }
                    'cshare' {
                        Start-Process 'explorer.exe' -ArgumentList "\\$computer\c$"
                        Send-Json $response @{ ok = $true; message = "Da mo o C$ cua $computer" }
                    }
                    'restart' {
                        Restart-Computer -ComputerName $computer -Force
                        Send-Json $response @{ ok = $true; message = "Da gui lenh khoi dong lai $computer" }
                    }
                    'shutdown' {
                        Stop-Computer -ComputerName $computer -Force
                        Send-Json $response @{ ok = $true; message = "Da gui lenh tat $computer" }
                    }
                    default {
                        Send-Json $response @{ error = 'Hanh dong khong hop le.' } 400
                    }
                }
            }

            default {
                Send-Text $response '404' 'text/plain; charset=utf-8' 404
            }
        }
    } catch {
        Write-ServerLog 'ERROR' ("Unhandled request error: {0} | {1}" -f $_.Exception.Message, $_.ScriptStackTrace)

        if ($response) {
            try {
                Send-Json $response @{
                    error = $_.Exception.Message
                    detail = $_.ScriptStackTrace
                    logFile = $LogFile
                } 500
            } catch {}
        }

        Write-Host $_.Exception.Message -ForegroundColor Red
    } finally {
        if ($response) {
            try { $response.OutputStream.Close() } catch {}
            try { $response.Close() } catch {}
        }
    }
}
