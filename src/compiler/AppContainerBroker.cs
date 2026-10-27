// Application-specific Windows AppContainer broker. No toolchain/project code runs here.
// Built with the Windows .NET Framework C# compiler; no external NuGet dependency.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class AppContainerBroker {
  const string Profile = "BPE.Compiler.v1";
  const uint EXTENDED = 0x00080000, SUSPENDED = 4, NO_WINDOW = 0x08000000, UNICODE_ENV = 0x400;
  const uint STARTF_USESTDHANDLES = 0x100;
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, CREATE_ALWAYS = 2, OPEN_EXISTING = 3;
  const uint FILE_SHARE_READ = 1, FILE_ATTRIBUTE_NORMAL = 0x80;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 8;
  const uint WAIT_TIMEOUT = 258;
  static readonly IntPtr Invalid = new IntPtr(-1);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024 };
  static volatile bool CancelRequested=false;

  public sealed class Request {
    public string operation { get; set; }
    public string runtimeRoot { get; set; }
    public string inputRoot { get; set; }
    public string outputRoot { get; set; }
    public string executable { get; set; }
    public string[] arguments { get; set; }
    public Dictionary<string,string> environment { get; set; }
    public int wallMs { get; set; }
    public int cpuSeconds { get; set; }
    public long memoryBytes { get; set; }
    public long outputBytes { get; set; }
    public int outputFiles { get; set; }
    public string cancelFile { get; set; }
    public bool testProbe { get; set; }
    public bool cancelViaStdin { get; set; }
    public string texConfig { get; set; }
    public string fontConfig { get; set; }
    public Dictionary<string,string> mountHints { get; set; }
  }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder commandLine,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref SECURITY_ATTRIBUTES attributes,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,IntPtr information,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int infoClass,IntPtr info,int size,out int returned);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DefineDosDevice(uint flags,string name,string target);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint QueryDosDevice(string name,StringBuilder target,int capacity);

  static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static string Full(string value) { if(String.IsNullOrWhiteSpace(value)) throw new ArgumentException("A required directory is missing."); string full=Path.GetFullPath(value);return full.Length==Path.GetPathRoot(full).Length?full:full.TrimEnd(Path.DirectorySeparatorChar); }
  static bool Within(string root,string value) { return value.Equals(root,StringComparison.OrdinalIgnoreCase)||value.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase); }
  static IEnumerable<string> OutputDirectoryEntries(string directory,bool required) {
    // Fontconfig creates/removes .LCK directories while the process runs. A
    // child may disappear between being queued and being enumerated. Only that
    // disappearance is benign; the output root and other I/O failures stay fatal.
    IEnumerator<string> entries=null;
    try{entries=Directory.EnumerateFileSystemEntries(directory).GetEnumerator();}
    catch(DirectoryNotFoundException){if(required)throw;}
    if(entries==null)yield break;
    using(entries)while(true) {
      string entry=null;bool found=false;
      try{found=entries.MoveNext();if(found)entry=entries.Current;}
      catch(DirectoryNotFoundException){if(required)throw;}
      if(!found)yield break;
      yield return entry;
    }
  }
  sealed class Mount { public string Kind,Drive,Target,Original; }
  static List<Mount> MountDirectories(string runtime,string input,string output,Dictionary<string,string> hints) {
    var mounts=new List<Mount>();
    using(var mutex=new Mutex(false,@"Local\BilingualPaperEditor.Compiler.Mounts")) {
      bool locked=false;try {
        try{locked=mutex.WaitOne(10000);}catch(AbandonedMutexException){locked=true;}
        if(!locked)throw new InvalidOperationException("Compiler drive allocation is busy.");
        var roots=new Dictionary<string,string>{{"runtime",runtime},{"input",input},{"output",output}};
        foreach(var pair in roots) {
          string device=null,hint;
          IEnumerable<char> letters="ZYXWVUTSRQPONMLKJIHGF";
          if(hints!=null&&hints.TryGetValue(pair.Key,out hint)) {
            if(!Regex.IsMatch(hint,@"^[F-Z]:[\\/]?$"))throw new ArgumentException("Invalid compiler drive hint.");
            letters=new[]{hint[0]};
          }
          foreach(char letter in letters) {
            string candidate=letter+":";
            if(QueryDosDevice(candidate,new StringBuilder(1024),1024)==0&&Marshal.GetLastWin32Error()==2){device=candidate;break;}
          }
          if(device==null)throw new InvalidOperationException("The required private compiler drive is busy.");
          string target=@"\??\"+pair.Value;
          Check(DefineDosDevice(1|8,device,target),"Create private compiler drive");
          mounts.Add(new Mount{Kind=pair.Key,Drive=device+"\\",Target=target,Original=pair.Value});
        }
        return mounts;
      }catch {foreach(var mount in mounts)DefineDosDevice(1|2|4|8,mount.Drive.TrimEnd('\\'),mount.Target);throw;}
      finally {if(locked)mutex.ReleaseMutex();}
    }
  }
  static bool Unmount(List<Mount> mounts) {
    if(mounts==null)return true;bool success=true;
    using(var mutex=new Mutex(false,@"Local\BilingualPaperEditor.Compiler.Mounts")) {
      bool locked=false;try{try{locked=mutex.WaitOne(10000);}catch(AbandonedMutexException){locked=true;}if(!locked)return false;
        foreach(var mount in mounts)if(!DefineDosDevice(1|2|4|8,mount.Drive.TrimEnd('\\'),mount.Target))success=false;
      }finally{if(locked)mutex.ReleaseMutex();}
    }
    return success;
  }
  static string Relocate(string value,List<Mount> mounts) {
    foreach(var mount in mounts){string root=mount.Original.Replace('\\','/');value=Regex.Replace(value,Regex.Escape(root),mount.Drive.TrimEnd('\\').Replace('\\','/'),RegexOptions.IgnoreCase);value=Regex.Replace(value,Regex.Escape(mount.Original),mount.Drive.TrimEnd('\\'),RegexOptions.IgnoreCase);}
    return value;
  }
  static void NoReparse(string root) {
    string cursor=root;
    while(!String.IsNullOrEmpty(cursor)) { if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("Reparse paths are forbidden."); cursor=Path.GetDirectoryName(cursor); }
  }
  static IntPtr ProfileSid(out string profile) {
    IntPtr sid;
    profile=Profile+"."+Guid.NewGuid().ToString("N");
    int result=CreateAppContainerProfile(profile,"Bilingual Paper Compiler","Restricted local LaTeX compiler; no capabilities.",IntPtr.Zero,0,out sid);
    if(result<0)Marshal.ThrowExceptionForHR(result);
    return sid;
  }
  static void Grant(string directory,SecurityIdentifier sid,FileSystemRights rights) {
    var security=Directory.GetAccessControl(directory);
    foreach(FileSystemAccessRule rule in security.GetAccessRules(true,false,typeof(SecurityIdentifier))) {
      if(rule.IdentityReference.Equals(sid)&&rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&rights)==rights&&rule.InheritanceFlags==(InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit))return;
    }
    security.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    Directory.SetAccessControl(directory,security);
  }
  static void Revoke(string directory,SecurityIdentifier sid) {
    var security=Directory.GetAccessControl(directory);
    security.RemoveAccessRuleAll(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    Directory.SetAccessControl(directory,security);
  }
  static bool PublicRuntime(string directory) {
    string manifest=Path.Combine(directory,"compiler-public-assets.json");
    if(!File.Exists(manifest))throw new InvalidOperationException("The public runtime inventory is missing.");
    if(new FileInfo(manifest).Length>32*1024*1024)throw new InvalidOperationException("Public runtime inventory exceeds policy.");
    var metadata=new JavaScriptSerializer{MaxJsonLength=32*1024*1024}.Deserialize<Dictionary<string,object>>(File.ReadAllText(manifest));
    if((string)metadata["scope"]!="public-assets-only"||(bool)metadata["containsPrivateInputs"]||(bool)metadata["containsSecrets"])throw new InvalidOperationException("Runtime inventory is not public-assets-only.");
    var all=new SecurityIdentifier("S-1-15-2-1");
    foreach(FileSystemAccessRule rule in Directory.GetAccessControl(directory).GetAccessRules(true,true,typeof(SecurityIdentifier))) {
      if(rule.IdentityReference.Equals(all)&&rule.AccessControlType==AccessControlType.Allow) {
        var writes=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership|FileSystemRights.DeleteSubdirectoriesAndFiles;
        if((rule.FileSystemRights&writes)!=0)throw new InvalidOperationException("Public runtime ACL unexpectedly permits writes.");
        if((rule.FileSystemRights&FileSystemRights.ReadAndExecute)==FileSystemRights.ReadAndExecute)return true;
      }
    }
    throw new InvalidOperationException("Public runtime read-only deployment ACL is missing.");
  }
  static void Add(IntPtr list,long attribute,IntPtr value,int size) { Check(UpdateProcThreadAttribute(list,0,new IntPtr(attribute),value,new IntPtr(size),IntPtr.Zero,IntPtr.Zero),"UpdateProcThreadAttribute"); }
  static IntPtr Structure<T>(T value) { IntPtr pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T))); Marshal.StructureToPtr(value,pointer,false); return pointer; }
  static string Quote(string argument) {
    if(argument==null||argument.IndexOf('\0')>=0) throw new ArgumentException("Invalid process argument.");
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in argument) { if(c=='\\') { slashes++; continue; } if(c=='\"') { result.Append('\\',slashes*2+1);result.Append(c);slashes=0;continue;} result.Append('\\',slashes);slashes=0;result.Append(c); }
    result.Append('\\',slashes*2);result.Append('"');return result.ToString();
  }
  static object TokenEvidence(IntPtr process,string expectedSid,string profile) {
    IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;
    try {
      Check(OpenProcessToken(process,TOKEN_QUERY,out token),"OpenProcessToken");
      int returned;
      buffer=Marshal.AllocHGlobal(64);
      Check(GetTokenInformation(token,29,buffer,64,out returned),"TokenIsAppContainer");
      if(Marshal.ReadInt32(buffer)!=1) throw new InvalidOperationException("Child token is not an AppContainer.");
      Check(GetTokenInformation(token,31,buffer,64,out returned),"TokenAppContainerSid");
      string actual=new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
      if(actual!=expectedSid) throw new InvalidOperationException("Unexpected AppContainer identity.");
      GetTokenInformation(token,30,IntPtr.Zero,0,out returned);
      Marshal.FreeHGlobal(buffer);buffer=Marshal.AllocHGlobal(Math.Max(returned,64));
      Check(GetTokenInformation(token,30,buffer,Math.Max(returned,64),out returned),"TokenCapabilities");
      int capabilityCount=Marshal.ReadInt32(buffer);
      if(capabilityCount!=0) throw new InvalidOperationException("Unexpected child capabilities.");
      return new { appContainer=true,zeroCapabilities=true,profile=profile,childProcessRestricted=true,jobActiveProcessLimit=1,handleAllowlist=true,perProcessIdentity=true };
    } finally { if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=IntPtr.Zero)CloseHandle(token); }
  }
  static object Run(Request request) {
    string runtime=Full(request.runtimeRoot), input=Full(request.inputRoot), output=Full(request.outputRoot);
    NoReparse(runtime);NoReparse(input);NoReparse(output);
    if(Within(input,output)||Within(output,input)||Within(runtime,input)||Within(runtime,output)) throw new InvalidOperationException("Runtime, input and output must be separate directories.");
    string executable=Path.GetFullPath(request.executable);
    if(!Within(runtime,executable)||!File.Exists(executable)) throw new InvalidOperationException("Executable is outside the provisioned runtime.");
    string exeName=Path.GetFileName(executable).ToLowerInvariant();
    if(!new[]{"xelatex.exe","pdflatex.exe","xdvipdfmx.exe","bibtex.exe","synctex.exe"}.Contains(exeName)&&!(request.testProbe&&exeName=="appcontainerprobe.exe")) throw new InvalidOperationException("Executable is not allowlisted.");
    if(request.arguments==null||request.arguments.Length>32||request.arguments.Sum(a=>a==null?0:a.Length)>16384)throw new ArgumentException("Process arguments exceed limits.");
    if(request.wallMs<100||request.wallMs>180000||request.cpuSeconds<1||request.cpuSeconds>120||request.memoryBytes<32*1024*1024||request.memoryBytes>2L*1024*1024*1024||request.outputBytes<1024||request.outputBytes>128*1024*1024||request.outputFiles<1||request.outputFiles>2000)throw new ArgumentException("Resource limits are outside policy.");
    if(!String.IsNullOrEmpty(request.cancelFile)&&!Within(output,Path.GetFullPath(request.cancelFile)))throw new ArgumentException("Cancel marker is outside output.");
    IntPtr sid=IntPtr.Zero,list=IntPtr.Zero,security=IntPtr.Zero,policy=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero,jobInfo=IntPtr.Zero,stdout=IntPtr.Zero,stdin=IntPtr.Zero;
    var process=new PROCESS_INFORMATION();
    bool created=false;string profile=null;SecurityIdentifier identity=null;List<Mount> mounts=null;Mutex invocation=null;bool invocationLocked=false;
    var cleanup=new Dictionary<string,bool>();
    try {
      invocation=new Mutex(false,@"Local\BilingualPaperEditor.Compiler.Invocation");
      var queued=Stopwatch.StartNew();
      while(!invocationLocked){
        try{invocationLocked=invocation.WaitOne(50);}catch(AbandonedMutexException){invocationLocked=true;}
        if(CancelRequested)throw new OperationCanceledException("Queued compilation was cancelled.");
        if(queued.ElapsedMilliseconds>180000)throw new InvalidOperationException("The native compiler queue timed out.");
      }
      sid=ProfileSid(out profile);string sidText=new SecurityIdentifier(sid).Value;
      identity=new SecurityIdentifier(sid);
      PublicRuntime(runtime);
      Grant(input,identity,FileSystemRights.ReadAndExecute);
      Grant(output,identity,FileSystemRights.Modify);
      mounts=MountDirectories(runtime,input,output,request.mountHints);
      string mountedRuntime=mounts.Find(m=>m.Kind=="runtime").Drive,mountedInput=mounts.Find(m=>m.Kind=="input").Drive,mountedOutput=mounts.Find(m=>m.Kind=="output").Drive;
      string config=Path.Combine(input,".paper-compiler-config-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(config);
      if(request.texConfig!=null){if(request.texConfig.Length>200000)throw new ArgumentException("Compiler configuration too large.");File.WriteAllText(Path.Combine(config,"texmf.cnf"),Relocate(request.texConfig,mounts),new UTF8Encoding(false));}
      if(request.fontConfig!=null){if(request.fontConfig.Length>65536)throw new ArgumentException("Font configuration too large.");File.WriteAllText(Path.Combine(config,"fonts.conf"),Relocate(request.fontConfig,mounts),new UTF8Encoding(false));}
      // The broker owns only these explicitly provisioned directories. No host/toolchain ACL changes.
      var inheritable=new SECURITY_ATTRIBUTES { nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),bInheritHandle=true };
      string log=Path.Combine(output,"worker-"+Guid.NewGuid().ToString("N")+".log");
      stdout=CreateFileW(log,GENERIC_WRITE,FILE_SHARE_READ,ref inheritable,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
      Check(stdout!=Invalid,"Create worker log");
      stdin=CreateFileW("NUL",GENERIC_READ,FILE_SHARE_READ,ref inheritable,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
      Check(stdin!=Invalid,"Create null input");
      IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref bytes);
      list=Marshal.AllocHGlobal(bytes);Check(InitializeProcThreadAttributeList(list,3,0,ref bytes),"InitializeProcThreadAttributeList");
      security=Structure(new SECURITY_CAPABILITIES{AppContainerSid=sid,Capabilities=IntPtr.Zero,CapabilityCount=0});Add(list,0x20009,security,Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
      policy=Marshal.AllocHGlobal(4);Marshal.WriteInt32(policy,1);Add(list,0x2000E,policy,4);
      handles=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(handles,0,stdout);Marshal.WriteIntPtr(handles,IntPtr.Size,stdin);Add(list,0x20002,handles,IntPtr.Size*2);
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"CreateJobObject");
      var limits=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags=0x2000|0x8|0x100|0x200|0x400|0x2;
      limits.BasicLimitInformation.ActiveProcessLimit=1;
      limits.BasicLimitInformation.PerProcessUserTimeLimit=(long)request.cpuSeconds*10000000;
      limits.ProcessMemoryLimit=(UIntPtr)(ulong)request.memoryBytes;limits.JobMemoryLimit=(UIntPtr)(ulong)request.memoryBytes;
      jobInfo=Structure(limits);Check(SetInformationJobObject(job,9,jobInfo,(uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))),"SetInformationJobObject");
      var environment=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      environment["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);environment["WINDIR"]=environment["SystemRoot"];
      environment["PATH"]=Path.Combine(mountedRuntime,"bin");environment["TEMP"]=mountedOutput;environment["TMP"]=mountedOutput;environment["USERPROFILE"]=mountedOutput;environment["APPDATA"]=mountedOutput;environment["LOCALAPPDATA"]=mountedOutput;
      var allowedEnv=new HashSet<string>(new[]{"TEXMFCNF","TEXMFROOT","TEXMF","TEXMFHOME","TEXMFLOCAL","TEXMFSYSVAR","TEXMFSYSCONFIG","TEXMFCONFIG","TEXMFVAR","TEXFORMATS","TEXINPUTS","TFMFONTS","VFFONTS","T1FONTS","OPENTYPEFONTS","TTFONTS","TEXFONTMAPS","ENCFONTS","BIBINPUTS","BSTINPUTS","FONTCONFIG_FILE","FONTCONFIG_PATH","OSFONTDIR","HOME","DVIPDFMXINPUTS","TEXPSHEADERS","MKTEXPK","MKTEXTFM","MKTEXMF","MKTEXFMT"},StringComparer.OrdinalIgnoreCase);
      if(request.environment!=null) foreach(var pair in request.environment) { if(!allowedEnv.Contains(pair.Key)||pair.Value==null||pair.Value.IndexOf('\0')>=0)throw new ArgumentException("Environment field is outside policy.");environment[pair.Key]=Relocate(pair.Value,mounts); }
      if(request.texConfig!=null)environment["TEXMFCNF"]=Relocate(config,mounts);
      if(request.fontConfig!=null){environment["FONTCONFIG_FILE"]=Relocate(Path.Combine(config,"fonts.conf"),mounts);environment["FONTCONFIG_PATH"]=Relocate(config,mounts);}
      string block=String.Join("\0",environment.Select(pair=>pair.Key+"="+pair.Value).ToArray())+"\0\0";env=Marshal.StringToHGlobalUni(block);
      var startup=new STARTUPINFOEX();startup.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES|1;startup.StartupInfo.wShowWindow=0;startup.StartupInfo.hStdInput=stdin;startup.StartupInfo.hStdOutput=stdout;startup.StartupInfo.hStdError=stdout;startup.lpAttributeList=list;
      string mountedExecutable=Relocate(executable,mounts);
      var command=new StringBuilder(Quote(mountedExecutable)+" "+String.Join(" ",request.arguments.Select(arg=>Quote(Relocate(arg,mounts))).ToArray()));
      Check(CreateProcessW(mountedExecutable,command,IntPtr.Zero,IntPtr.Zero,true,EXTENDED|SUSPENDED|UNICODE_ENV,env,mountedOutput,ref startup,out process),"Create AppContainer process");created=true;
      Check(AssignProcessToJobObject(job,process.hProcess),"AssignProcessToJobObject");
      object evidence=TokenEvidence(process.hProcess,sidText,profile);
      Check(ResumeThread(process.hThread)!=0xFFFFFFFF,"ResumeThread");
      var clock=Stopwatch.StartNew();string status="exited";
      while(WaitForSingleObject(process.hProcess,50)==WAIT_TIMEOUT) {
        if(CancelRequested||(!request.cancelViaStdin&&!String.IsNullOrEmpty(request.cancelFile)&&File.Exists(request.cancelFile))){status="cancelled";TerminateJobObject(job,0xE001);break;}
        if(clock.ElapsedMilliseconds>request.wallMs){status="timeout";TerminateJobObject(job,0xE002);break;}
        long size=0;int count=0;
        var directories=new Stack<string>();directories.Push(output);
        while(directories.Count>0&&status=="exited") {
          string directory=directories.Pop();
          foreach(string entry in OutputDirectoryEntries(directory,directory.Equals(output,StringComparison.OrdinalIgnoreCase))) {
          FileAttributes attributes;try{attributes=File.GetAttributes(entry);}catch(FileNotFoundException){continue;}catch(DirectoryNotFoundException){continue;}
          if((attributes&FileAttributes.ReparsePoint)!=0){status="unsafeOutput";TerminateJobObject(job,0xE003);break;}
          if(++count>request.outputFiles){status="outputLimit";TerminateJobObject(job,0xE003);break;}
          if((attributes&FileAttributes.Directory)!=0)directories.Push(entry);
          else {try{size+=new FileInfo(entry).Length;}catch(FileNotFoundException){continue;}if(size>request.outputBytes){status="outputLimit";TerminateJobObject(job,0xE003);break;}}
          }
        }
        if(status!="exited")break;
      }
      WaitForSingleObject(process.hProcess,5000);uint exit;Check(GetExitCodeProcess(process.hProcess,out exit),"GetExitCodeProcess");
      return new { ok=true,status=status,exitCode=exit,wallMs=clock.ElapsedMilliseconds,logPath=log,isolation=evidence,mountHints=mounts.ToDictionary(m=>m.Kind,m=>m.Drive),pathMap=mounts.ToDictionary(m=>m.Drive,m=>m.Original),cleanup=cleanup };
    } finally {
      if(created&&job!=IntPtr.Zero)TerminateJobObject(job,0xE004);
      if(process.hThread!=IntPtr.Zero)CloseHandle(process.hThread);if(process.hProcess!=IntPtr.Zero)CloseHandle(process.hProcess);
      if(job!=IntPtr.Zero)CloseHandle(job);if(stdout!=IntPtr.Zero&&stdout!=Invalid)CloseHandle(stdout);if(stdin!=IntPtr.Zero&&stdin!=Invalid)CloseHandle(stdin);
      if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}
      foreach(IntPtr pointer in new[]{security,policy,handles,env,jobInfo})if(pointer!=IntPtr.Zero)Marshal.FreeHGlobal(pointer);
      bool revoked=true;if(identity!=null)foreach(string directory in new[]{input,output})try{Revoke(directory,identity);}catch{revoked=false;}
      cleanup["aclRevoked"]=revoked;
      cleanup["profileDeleted"]=profile==null||DeleteAppContainerProfile(profile)>=0;
      cleanup["mountsRemoved"]=Unmount(mounts);
      if(sid!=IntPtr.Zero)FreeSid(sid);
      if(invocationLocked)invocation.ReleaseMutex();if(invocation!=null)invocation.Dispose();
    }
  }
  public static int Main(string[] args) {
    try {
      Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
      if(args.Length!=0)throw new ArgumentException("Read a bounded JSON request on stdin.");
      string line=Console.ReadLine();if(line==null||line.Length>1024*1024)throw new ArgumentException("Request is missing or too large.");
      var request=Json.Deserialize<Request>(line);
      if(request==null||request.operation!="run")throw new ArgumentException("Unsupported operation.");
      if(request.cancelViaStdin)ThreadPool.QueueUserWorkItem(delegate {string command;while((command=Console.ReadLine())!=null){if(command=="cancel"){CancelRequested=true;return;}}CancelRequested=true;});
      Console.WriteLine(Json.Serialize(Run(request)));return 0;
    }catch(Exception error){var native=error as Win32Exception;Console.WriteLine(Json.Serialize(new{ok=false,code="SANDBOX_UNAVAILABLE",message=error.Message,nativeErrorCode=native==null?0:native.NativeErrorCode}));return 1;}
  }
}
