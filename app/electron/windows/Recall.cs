// C# 5 / .NET Framework 4.8. Runs only while NOVA is closed (Jarvis / Windows mode).
// Reads the controllers and Parsec's host log, nothing else. View + Menu held for
// 3 s, or a new Parsec connection, starts NOVA's mode picker.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
namespace Nova {
 public static class Recall {
  [StructLayout(LayoutKind.Sequential)] struct Pad {public ushort Buttons;public byte LT,RT;public short LX,LY,RX,RY;}
  [StructLayout(LayoutKind.Sequential)] struct PadState {public uint Packet;public Pad Pad;}
  [DllImport("xinput1_4.dll",EntryPoint="XInputGetState")]static extern uint XInput(uint index,out PadState state);
  // Same rules as parsec-watch.cjs: "[I date] Name#123 connected." counts, a reconnect within 2 minutes does not.
  static readonly Regex Connected=new Regex(@"\]\s*(\S.*?#\d+)\s+connected\.?\s*$",RegexOptions.IgnoreCase);
  static readonly Regex Disconnected=new Regex(@"\]\s*(\S.*?#\d+)\s+disconnected\.?\s*$",RegexOptions.IgnoreCase);
  sealed class LogFile {public string Path;public long Offset;public string Rest="";}
  static readonly Dictionary<string,long> Dropped=new Dictionary<string,long>();
  static long Length(string path){try{FileInfo info=new FileInfo(path);return info.Exists?info.Length:-1;}catch{return -1;}}
  static List<LogFile> ParsecLogs(){
   List<LogFile> logs=new List<LogFile>();
   foreach(Environment.SpecialFolder folder in new Environment.SpecialFolder[]{Environment.SpecialFolder.CommonApplicationData,Environment.SpecialFolder.ApplicationData}){
    LogFile log=new LogFile();log.Path=Path.Combine(Path.Combine(Environment.GetFolderPath(folder),"Parsec"),"log.txt");
    log.Offset=Math.Max(0,Length(log.Path));logs.Add(log);
   }
   return logs;
  }
  static bool ParsecConnected(List<LogFile> logs,long now){
   bool found=false;
   foreach(LogFile log in logs){
    long length=Length(log.Path);
    if(length<0){log.Offset=0;log.Rest="";continue;}
    if(length<log.Offset){log.Offset=0;log.Rest="";}
    if(length==log.Offset)continue;
    string text;
    try{
     using(FileStream stream=new FileStream(log.Path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)){
      long start=Math.Max(log.Offset,length-262144);stream.Seek(start,SeekOrigin.Begin);
      byte[] buffer=new byte[length-start];int count=stream.Read(buffer,0,buffer.Length);
      text=log.Rest+Encoding.UTF8.GetString(buffer,0,count);
     }
    }catch{continue;}
    log.Offset=length;
    string[] lines=text.Split('\n');log.Rest=lines[lines.Length-1];
    for(int i=0;i<lines.Length-1;i++){
     string line=lines[i].TrimEnd('\r');
     Match gone=Disconnected.Match(line);
     if(gone.Success){Dropped[gone.Groups[1].Value]=now;continue;}
     Match joined=Connected.Match(line);
     if(!joined.Success)continue;
     long last;
     if(Dropped.TryGetValue(joined.Groups[1].Value,out last)&&now-last<120000)continue;
     found=true;
    }
   }
   return found;
  }
  static bool NovaRunning(string exe){
   bool found=false;
   foreach(Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe))){
    try{if(String.Equals(process.MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase))found=true;}catch{}
    finally{process.Dispose();}
   }
   return found;
  }
  static void StartPicker(string exe){
   ProcessStartInfo start=new ProcessStartInfo(exe,"--mode-picker");
   start.UseShellExecute=false;start.WorkingDirectory=Path.GetDirectoryName(exe);
   Process.Start(start).Dispose();
  }
  public static void Run(string exe,int novaPid,bool parsec){
   if(!File.Exists(exe))return;
   bool created;
   using(Mutex single=new Mutex(true,"Local\\NovaModeRecall",out created)){
    if(!created)return;
    // Let the NOVA that started this watcher finish quitting first.
    try{using(Process nova=Process.GetProcessById(novaPid))nova.WaitForExit(30000);}catch{}
    Thread.Sleep(3000);
    List<LogFile> logs=parsec?ParsecLogs():new List<LogFile>();
    Stopwatch clock=Stopwatch.StartNew();long since=0,lastCheck=0,lastLog=0;long[] retry=new long[4];
    while(true){
     long now=clock.ElapsedMilliseconds;
     // NOVA started some other way: it takes over the controller and Parsec again.
     if(now-lastCheck>=2000){lastCheck=now;if(NovaRunning(exe))return;}
     if(parsec&&now-lastLog>=1500){lastLog=now;if(ParsecConnected(logs,now)){StartPicker(exe);return;}}
     bool held=false;
     for(uint index=0;index<4;index++){
      if(now<retry[index])continue;
      PadState state;
      // Polling an empty slot is slow; check it again only every few seconds.
      if(XInput(index,out state)!=0){retry[index]=now+3000;continue;}
      if((state.Pad.Buttons&0x30)==0x30)held=true;
     }
     if(!held)since=0;
     else{
      if(since==0)since=now;
      if(now-since>=3000){StartPicker(exe);return;}
     }
     Thread.Sleep(50);
    }
   }
  }
 }
}
