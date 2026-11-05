// Answer file for a fully unattended Windows 11 install. Structure adapted from quickemu's
// (MIT, https://github.com/quickemu-project/quickemu). Drive letters assume our CD-ROM order:
// D: Windows ISO, E: virtio-win, F: agent-vm unattend ISO. The first-logon command searches
// for its script instead of trusting F:, because Windows sometimes letters drives differently.

export interface UnattendOptions {
  computerName: string;
  user: string;
  password: string;
  locale: string;
  timeZone: string;
  productKey?: string;
  driverPaths: string[];
}

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const component = (name: string, body: string) =>
  `    <component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n${body}\n    </component>`;

export function unattendXml(o: UnattendOptions): string {
  const labConfig = ['BypassTPMCheck', 'BypassSecureBootCheck', 'BypassRAMCheck', 'BypassCPUCheck']
    .map(
      (key, i) => `        <RunSynchronousCommand wcm:action="add">
          <Order>${i + 1}</Order>
          <Path>reg add HKLM\\System\\Setup\\LabConfig /v ${key} /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>`,
    )
    .join('\n');

  const drivers = o.driverPaths
    .map(
      (path, i) => `        <PathAndCredentials wcm:action="add" wcm:keyValue="${i + 1}">
          <Path>E:\\${path.replace(/\//g, '\\')}</Path>
        </PathAndCredentials>`,
    )
    .join('\n');

  const productKey = o.productKey
    ? `        <ProductKey>\n          <Key>${xml(o.productKey)}</Key>\n          <WillShowUI>Never</WillShowUI>\n        </ProductKey>`
    : '';

  const international = (pe: boolean) =>
    component(
      pe ? 'Microsoft-Windows-International-Core-WinPE' : 'Microsoft-Windows-International-Core',
      `${pe ? `      <SetupUILanguage><UILanguage>${o.locale}</UILanguage></SetupUILanguage>\n` : ''}      <InputLocale>${o.locale}</InputLocale>
      <SystemLocale>${o.locale}</SystemLocale>
      <UILanguage>${o.locale}</UILanguage>
      <UserLocale>${o.locale}</UserLocale>`,
    );

  const firstLogon = `cmd /c for %d in (D E F G H I J) do if exist %d:\\agent-vm\\firstboot.ps1 powershell -NoProfile -ExecutionPolicy Bypass -File %d:\\agent-vm\\firstboot.ps1`;

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
${international(true)}
${component(
  'Microsoft-Windows-Setup',
  `      <RunSynchronous>
${labConfig}
      </RunSynchronous>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>FAT32</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
          <InstallToAvailablePartition>false</InstallToAvailablePartition>
        </OSImage>
      </ImageInstall>
      <DynamicUpdate><Enable>false</Enable><WillShowUI>Never</WillShowUI></DynamicUpdate>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <FullName>${xml(o.user)}</FullName>
${productKey}
      </UserData>`,
)}
${component('Microsoft-Windows-PnpCustomizationsWinPE', `      <DriverPaths>\n${drivers}\n      </DriverPaths>`)}
  </settings>
  <settings pass="specialize">
${component(
  'Microsoft-Windows-Shell-Setup',
  `      <ComputerName>${xml(o.computerName)}</ComputerName>
      <TimeZone>${xml(o.timeZone)}</TimeZone>`,
)}
${component('Microsoft-Windows-SQMApi', '      <CEIPEnabled>0</CEIPEnabled>')}
${component('Microsoft-Windows-Security-SPP-UX', '      <SkipAutoActivation>true</SkipAutoActivation>')}
  </settings>
  <settings pass="oobeSystem">
${international(false)}
${component(
  'Microsoft-Windows-Shell-Setup',
  `      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${xml(o.user)}</Name>
            <DisplayName>${xml(o.user)}</DisplayName>
            <Group>Administrators</Group>
            <Password><Value>${xml(o.password)}</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>${xml(o.user)}</Username>
        <Password><Value>${xml(o.password)}</Value><PlainText>true</PlainText></Password>
        <LogonCount>9999999</LogonCount>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>${xml(firstLogon)}</CommandLine>
          <Description>agent-vm first boot</Description>
        </SynchronousCommand>
      </FirstLogonCommands>`,
)}
  </settings>
</unattend>
`;
}
