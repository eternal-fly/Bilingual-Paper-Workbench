import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
test('broker output monitor tolerates disappearing cache entries but preserves other metadata failures', { skip: process.platform !== 'win32' }, async t => {
  const owned = path.join(root, 'work/compiler-output-race-tests'); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(owned) + path.sep)); await rm(directory, { recursive: true, force: true }); });
  const aliasTarget = path.join(directory, 'alias-target'), cache = path.join(directory, 'font-cache');
  await mkdir(aliasTarget); await mkdir(cache); await symlink(aliasTarget, path.join(cache, 'alias.LCK'), 'junction');
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), broker = path.join(directory, 'AppContainerBroker.exe');
  await execute(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/reference:System.Web.Extensions.dll', '/out:' + broker, path.join(root, 'src/compiler/AppContainerBroker.cs')], { windowsHide: true });
  const harness = path.join(directory, 'MonitorRegression.cs'), executable = path.join(directory, 'MonitorRegression.exe');
  await writeFile(harness, `using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
public static class MonitorRegression {
  static void Require(bool value,string message) { if(!value)throw new Exception(message); }
  public static int Main(string[] args) {
    var method=Assembly.LoadFrom(args[0]).GetType("AppContainerBroker").GetMethod("OutputDirectoryEntries",BindingFlags.NonPublic|BindingFlags.Static);
    Require(method!=null,"Broker output directory accessor is missing.");
    Func<string,bool,string[]> read=(directory,required)=>((IEnumerable<string>)method.Invoke(null,new object[]{directory,required})).ToArray();
    string root=args[1],cache=Path.Combine(root,"font-cache"),missingLock=Path.Combine(cache,"gone.LCK"),queuedLock=Path.Combine(cache,"queued.LCK"),denied=Path.Combine(cache,"denied.LCK");
    Directory.CreateDirectory(cache);File.WriteAllBytes(Path.Combine(cache,"cache.dat"),new byte[37]);
    var existing=read(cache,false);Require(existing.Length==2,"Existing entries must remain visible to byte, file and alias checks.");
    Require(existing.Any(entry=>(File.GetAttributes(entry)&FileAttributes.ReparsePoint)!=0),"Aliases must remain visible to the sandbox monitor's existing rejection check.");
    bool observedOriginalFailure=false;
    try { Directory.EnumerateFileSystemEntries(missingLock).ToArray(); } catch(DirectoryNotFoundException) { observedOriginalFailure=true; }
    Require(observedOriginalFailure,"The original .NET directory accessor must reproduce the vanished-lock failure.");
    Require(read(missingLock,false).Length==0,"A vanished child lock must not stop monitoring.");
    Directory.CreateDirectory(queuedLock);var queued=(IEnumerable<string>)method.Invoke(null,new object[]{queuedLock,false});Directory.Delete(queuedLock);
    Require(queued.ToArray().Length==0,"A lock deleted between queuing and enumeration must not stop monitoring.");
    bool rejectedMissingRoot=false;try { read(missingLock,true); } catch(DirectoryNotFoundException) { rejectedMissingRoot=true; }
    Require(rejectedMissingRoot,"A disappeared output root must remain fatal.");
    bool rejectedInvalidPath=false;
    try { read("invalid"+((char)0)+"path",false); } catch(ArgumentException) { rejectedInvalidPath=true; }
    Require(rejectedInvalidPath,"Other directory failures must propagate instead of weakening sandbox enforcement.");
    Directory.CreateDirectory(denied);var originalAcl=Directory.GetAccessControl(denied);var deniedAcl=Directory.GetAccessControl(denied);
    deniedAcl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.ListDirectory,AccessControlType.Deny));
    bool rejectedPermission=false;
    try { Directory.SetAccessControl(denied,deniedAcl);try { read(denied,false); } catch(UnauthorizedAccessException) { rejectedPermission=true; } }
    finally { Directory.SetAccessControl(denied,originalAcl); }
    Require(rejectedPermission,"Permission errors must remain fatal.");
    Console.WriteLine("{\\"checks\\":9,\\"originalDirectoryRaceReproduced\\":true}");
    return 0;
  }
}`);
  await execute(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/out:' + executable, harness], { windowsHide: true });
  const result = await execute(executable, [broker, directory], { windowsHide: true });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { checks: 9, originalDirectoryRaceReproduced: true });
});
