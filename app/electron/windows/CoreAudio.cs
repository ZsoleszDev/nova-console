// Windows Core Audio endpoint volume. No input injection into games.
using System;
using System.Runtime.InteropServices;
namespace Nova {
 [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator {}
 [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevices {
  [PreserveSig]int EnumAudioEndpoints(int flow,uint mask,out IntPtr devices);
  [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out IDevice device);
 }
 [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
  [PreserveSig]int Activate(ref Guid iid,uint context,IntPtr activation,[MarshalAs(UnmanagedType.IUnknown)]out object result);
 }
 [ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IVolume {
  [PreserveSig]int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig]int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig]int GetChannelCount(out uint count);
  [PreserveSig]int SetMasterVolumeLevel(float level,ref Guid context);
  [PreserveSig]int SetMasterVolumeLevelScalar(float level,ref Guid context);
  [PreserveSig]int GetMasterVolumeLevel(out float level);
  [PreserveSig]int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig]int SetChannelVolumeLevel(uint channel,float level,ref Guid context);
  [PreserveSig]int SetChannelVolumeLevelScalar(uint channel,float level,ref Guid context);
  [PreserveSig]int GetChannelVolumeLevel(uint channel,out float level);
  [PreserveSig]int GetChannelVolumeLevelScalar(uint channel,out float level);
  [PreserveSig]int SetMute([MarshalAs(UnmanagedType.Bool)]bool mute,ref Guid context);
  [PreserveSig]int GetMute([MarshalAs(UnmanagedType.Bool)]out bool mute);
 }
 public static class CoreAudio {
  public static string Apply(string action,int value) {
   object enumerator=null,endpoint=null;IDevice device=null;
   try {
    enumerator=new DeviceEnumerator();Marshal.ThrowExceptionForHR(((IDevices)enumerator).GetDefaultAudioEndpoint(0,1,out device));
    Guid id=typeof(IVolume).GUID;Marshal.ThrowExceptionForHR(device.Activate(ref id,23,IntPtr.Zero,out endpoint));IVolume volume=(IVolume)endpoint;Guid context=Guid.Empty;
    if(action=="set")Marshal.ThrowExceptionForHR(volume.SetMasterVolumeLevelScalar(Math.Max(0,Math.Min(100,value))/100f,ref context));
    if(action=="mute")Marshal.ThrowExceptionForHR(volume.SetMute(value!=0,ref context));
    float level;bool mute;Marshal.ThrowExceptionForHR(volume.GetMasterVolumeLevelScalar(out level));Marshal.ThrowExceptionForHR(volume.GetMute(out mute));
    return "{\"type\":\"audio\",\"available\":true,\"volume\":"+((int)Math.Round(level*100))+",\"muted\":"+(mute?"true":"false")+"}";
   } catch { return "{\"type\":\"audio\",\"available\":false}"; }
   finally { if(endpoint!=null)Marshal.ReleaseComObject(endpoint);if(device!=null)Marshal.ReleaseComObject(device);if(enumerator!=null)Marshal.ReleaseComObject(enumerator); }
  }
 }
}
