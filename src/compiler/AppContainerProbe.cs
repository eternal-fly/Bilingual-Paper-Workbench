using System;
using System.IO;
using System.Net.Sockets;
using System.Diagnostics;
public static class AppContainerProbe {
  static string Escape(string value){return value.Replace("\\","\\\\").Replace("\"","\\\"");}
  public static int Main(string[] args){
    bool read=false,write=false,output=false,spawn=false,network=false,inputWrite=false;int socketError=0;
    string secret=args[0],outside=args[1],allowed=args[2];int port=Int32.Parse(args[3]);
    try{File.ReadAllText(secret);read=true;}catch{}
    try{File.WriteAllText(outside,"escaped");write=true;}catch{}
    try{File.WriteAllText(allowed,"allowed");output=true;}catch{}
    if(args.Length>4)try{File.WriteAllText(args[4],"changed");inputWrite=true;}catch{}
    try{using(var client=new TcpClient()){var task=client.ConnectAsync("127.0.0.1",port);if(task.Wait(3000)){network=client.Connected;}else{socketError=10060;}}}catch(AggregateException e){var socket=e.GetBaseException() as SocketException;if(socket!=null)socketError=socket.NativeErrorCode;}catch(SocketException e){socketError=e.NativeErrorCode;}catch{}
    try{var p=Process.Start(new ProcessStartInfo("C:\\Windows\\System32\\cmd.exe","/c exit 0"){UseShellExecute=false,CreateNoWindow=true});if(p!=null){spawn=true;p.WaitForExit();}}catch{}
    Console.WriteLine("{\"privateRead\":"+read.ToString().ToLower()+",\"hostWrite\":"+write.ToString().ToLower()+",\"outputWrite\":"+output.ToString().ToLower()+",\"inputWrite\":"+inputWrite.ToString().ToLower()+",\"childSpawn\":"+spawn.ToString().ToLower()+",\"loopbackNetwork\":"+network.ToString().ToLower()+",\"socketError\":"+socketError+"}");
    return read||write||spawn||network||inputWrite||!output||(socketError!=10013&&socketError!=10060)?1:0;
  }
}
