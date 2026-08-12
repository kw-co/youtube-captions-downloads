import React, { useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import { initAuth, googleSignIn, logout, getAccessToken } from './auth';
import { getUploadsPlaylistId, syncVideos, getVideoCaptions, downloadCaptionTrack, YouTubeVideo } from './youtube';
import { sanitizeFilename } from './utils';
import JSZip from 'jszip';
import { LogOut, Download, Youtube, Loader2, CheckCircle2, AlertCircle, RefreshCw, CheckSquare, Square } from 'lucide-react';

export default function App() {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  
  const [isSyncing, setIsSyncing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const [progressText, setProgressText] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    initAuth(
      (user) => {
        setUser(user);
        setNeedsAuth(false);
        loadLocalData();
      },
      () => {
        setUser(null);
        setNeedsAuth(true);
      }
    );
  }, []);

  const loadLocalData = () => {
    const storedVideos = localStorage.getItem('yt_videos');
    if (storedVideos) {
      try { 
        const parsed = JSON.parse(storedVideos);
        // Deduplicate in case of existing corrupted data
        const uniqueVideos = Array.from(new Map(parsed.map((v: YouTubeVideo) => [v.id, v])).values()) as YouTubeVideo[];
        setVideos(uniqueVideos); 
      } catch (e) {}
    }
    const storedDownloaded = localStorage.getItem('yt_downloaded_ids');
    if (storedDownloaded) {
      try { setDownloadedIds(new Set<string>(JSON.parse(storedDownloaded))); } catch (e) {}
    }
  };

  const saveVideos = (newVideos: YouTubeVideo[]) => {
    // Deduplicate before saving
    const uniqueVideos = Array.from(new Map(newVideos.map(v => [v.id, v])).values());
    setVideos(uniqueVideos);
    localStorage.setItem('yt_videos', JSON.stringify(uniqueVideos));
  };

  const saveDownloaded = (newIds: Set<string>) => {
    setDownloadedIds(newIds);
    localStorage.setItem('yt_downloaded_ids', JSON.stringify(Array.from(newIds)));
  };

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setNeedsAuth(false);
        loadLocalData();
      }
    } catch (err: any) {
      console.error('Login failed:', err);
      setError(err.message || 'Failed to sign in.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setNeedsAuth(true);
    setSuccess(false);
    setError(null);
    setProgressText('');
    setProgressPercent(0);
    setVideos([]);
    setSelectedIds(new Set());
    setDownloadedIds(new Set());
  };

  const handleSync = async () => {
    setIsSyncing(true);
    setError(null);
    setSuccess(false);
    setProgressText('جاري الاتصال بقناتك...');
    
    try {
      let token = await getAccessToken();
      if (!token) {
        setProgressText('جاري تجديد إذن الوصول ليوتيوب...');
        const result = await googleSignIn();
        token = result?.accessToken || null;
      }
      if (!token) throw new Error("غير مصرح لك");
      
      const playlistId = await getUploadsPlaylistId(token);
      
      const existingIds = new Set<string>(videos.map(v => v.id));
      setProgressText('جاري البحث عن فيديوهات جديدة...');
      
      const newVideos = await syncVideos(token, playlistId, existingIds, (count) => {
        setProgressText(`جاري جلب ${count} فيديو جديد...`);
      });
      
      if (newVideos.length > 0) {
        saveVideos([...newVideos, ...videos]);
        setProgressText(`تمت إضافة ${newVideos.length} فيديو جديد!`);
      } else {
        setProgressText('القائمة محدثة مسبقاً، لا توجد فيديوهات جديدة.');
      }
    } catch (err: any) {
      console.error('Sync failed:', err);
      setError(err.message || 'حدث خطأ أثناء تحديث القائمة.');
    } finally {
      setIsSyncing(false);
      setTimeout(() => setProgressText(''), 4000);
    }
  };

  const toggleSelection = (id: string) => {
    const newSelection = new Set<string>(selectedIds);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedIds(newSelection);
  };

  const selectNextBatch = (size: number) => {
    const newSelection = new Set<string>(selectedIds);
    let added = 0;
    for (const video of videos) {
      if (!downloadedIds.has(video.id) && !newSelection.has(video.id)) {
        newSelection.add(video.id);
        added++;
        if (added === size) break;
      }
    }
    setSelectedIds(newSelection);
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const startDownload = async () => {
    const videosToProcess = videos.filter(v => selectedIds.has(v.id));
    if (videosToProcess.length === 0) return;

    setIsProcessing(true);
    setError(null);
    setSuccess(false);
    setProgressPercent(0);
    setProgressText('جاري التهيئة...');
    
    try {
      let token = await getAccessToken();
      if (!token) {
        setProgressText('جاري تجديد إذن الوصول ليوتيوب...');
        const result = await googleSignIn();
        token = result?.accessToken || null;
      }
      if (!token) throw new Error("غير مصرح لك");

      const zip = new JSZip();
      const captionsFolder = zip.folder('Captions')!;
      let linksText = 'YouTube Videos Links:\n\n';
      
      let processed = 0;
      let totalDownloaded = 0;
      let quotaExceeded = false;
      const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
      const newDownloadedIds = new Set<string>(downloadedIds);

      for (let i = 0; i < videosToProcess.length; i++) {
        if (quotaExceeded) break;
        const video = videosToProcess[i];
        
        try {
          setProgressText(`جاري معالجة الفيديو ${processed + 1} من ${videosToProcess.length}...`);
          const captions = await getVideoCaptions(token, video.id);
          linksText += `${video.title}\n${video.url}\n\n`;

          for (const caption of captions) {
            if (quotaExceeded) break;
            try {
              const srtData = await downloadCaptionTrack(token, caption.id);
              const safeTitle = sanitizeFilename(video.title);
              const langSuffix = caption.language ? `_${caption.language}` : '';
              
              const fileContent = `العنوان: ${video.title}\nالرابط: ${video.url}\n\n${srtData}`;
              captionsFolder.file(`${safeTitle}${langSuffix}.txt`, fileContent);
              totalDownloaded++;
            } catch (err: any) {
              console.error(`Failed to download caption ${caption.id} for video ${video.id}`, err);
              if (err.message && err.message.includes('الحد المسموح')) {
                quotaExceeded = true;
              }
            }
          }
          
          if (!quotaExceeded) {
             newDownloadedIds.add(video.id);
          }
        } catch (err: any) {
           console.error(`Failed to fetch captions list for video ${video.id}`, err);
           if (err.message && err.message.includes('الحد المسموح')) {
             quotaExceeded = true;
           }
        }
        
        processed++;
        setProgressPercent(Math.round((processed / videosToProcess.length) * 100));
        await delay(300);
      }

      saveDownloaded(newDownloadedIds);

      if (totalDownloaded > 0) {
        setProgressText('جاري إنشاء الملف المضغوط...');
        zip.file('Video_Links.txt', linksText);
        
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        
        setProgressText('جاري تنزيل الملف...');
        const downloadUrl = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'YouTube_Captions.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
      }

      setSuccess(true);
      setSelectedIds(new Set()); // clear selected after successful processing
      
      if (quotaExceeded) {
        setProgressText(`تنبيه: تم الوصول للحد الأقصى لطلبات يوتيوب (Quota). تم حفظ ${totalDownloaded} ملف بنجاح!`);
      } else {
        setProgressText(`تم بنجاح تحميل ${totalDownloaded} ملف ترجمة!`);
      }
    } catch (err: any) {
      console.error('Download process failed:', err);
      setError(err.message || 'حدث خطأ أثناء عملية التحميل.');
    } finally {
      setIsProcessing(false);
    }
  };

  if (needsAuth) {
    return (
      <div className="min-h-screen bg-gradient-to-bl from-[#0A0A0A] to-[#050505] flex flex-col items-center justify-center p-4" dir="rtl">
        <div className="bg-[#0A0A0A] p-8 rounded-xl shadow-[0_0_40px_rgba(0,0,0,0.5)] border border-[#1F1F1F] max-w-md w-full text-center">
          <div className="w-16 h-16 bg-[#0F0F0F] border border-[#1F1F1F] text-[#D4AF37] rounded-full flex items-center justify-center mx-auto mb-6">
            <Youtube size={32} />
          </div>
          <h1 className="text-4xl font-serif italic text-white mb-2">مدير التراجم</h1>
          <p className="text-[#888] mb-8">قم بتسجيل الدخول بحساب يوتيوب الخاص بك لجلب وتحميل كافة ملفات الترجمة الخاصة بفيديوهاتك.</p>
          
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full flex items-center justify-center gap-3 bg-[#0F0F0F] border border-[#1F1F1F] hover:bg-[#111] text-[#E0E0E0] px-6 py-4 rounded-lg font-medium transition-colors disabled:opacity-50 shadow-sm"
          >
            {isLoggingIn ? (
              <Loader2 className="animate-spin text-[#666]" size={20} />
            ) : (
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                <path fill="none" d="M0 0h48v48H0z" />
              </svg>
            )}
            {isLoggingIn ? 'جاري تسجيل الدخول...' : 'تسجيل الدخول باستخدام جوجل'}
          </button>
          
          {error && (
            <div className="mt-4 p-3 bg-red-950/30 border border-red-900/50 text-red-500 rounded-lg text-sm flex items-start gap-2 text-right">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] flex flex-col font-sans text-[#E0E0E0] h-screen overflow-hidden" dir="rtl">
      <div className="w-full flex-1 flex flex-col mx-auto max-w-7xl px-4 md:px-8 py-6 h-full">
        
        <header className="flex flex-col md:flex-row justify-between items-center md:items-end mb-6 shrink-0 gap-6">
          <div className="space-y-1 text-center md:text-right w-full">
            <h1 className="text-4xl font-serif italic text-white">مدير التراجم</h1>
            <p className="text-[#888] text-sm">تحديد وتحميل ملفات الترجمة بمرونة.</p>
          </div>
          <div className="flex items-center gap-4 mt-4 md:mt-0 shrink-0">
            <div className="flex items-center gap-4 bg-[#0A0A0A] border border-[#1F1F1F] p-2 pr-4 rounded-xl shadow-sm">
              <div className="text-right">
                <p className="text-sm font-semibold tracking-wide text-white">{user?.displayName || 'قناتي الخاصة'}</p>
                <p className="text-xs text-[#888] font-mono">{user?.email}</p>
              </div>
              <div className="w-10 h-10 shrink-0">
                {user?.photoURL ? (
                  <img src={user.photoURL} alt="Avatar" className="w-full h-full rounded-full border border-[#D4AF37] object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-full h-full rounded-full bg-[#D4AF37] flex items-center justify-center text-black font-bold text-xl">
                    {user?.email?.[0]?.toUpperCase() || 'M'}
                  </div>
                )}
              </div>
            </div>
            <button 
              onClick={handleLogout}
              disabled={isProcessing || isSyncing}
              className="p-3 text-[#666] bg-[#0F0F0F] border border-[#1F1F1F] hover:text-[#D4AF37] hover:bg-[#111] rounded-xl transition-colors disabled:opacity-50 shadow-sm shrink-0"
              title="تسجيل الخروج"
            >
              <LogOut size={20} />
            </button>
          </div>
        </header>

        {error && !isProcessing && (
          <div className="mb-4 p-4 bg-red-950/20 border border-red-900/50 text-red-400 rounded-xl flex items-start gap-3 shrink-0">
            <AlertCircle size={20} className="mt-0.5 text-red-500 shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        <section className="flex-1 bg-[#0A0A0A] border border-[#1F1F1F] rounded-xl flex flex-col shadow-lg overflow-hidden relative">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#D4AF37] to-transparent opacity-20"></div>
          
          <div className="p-4 border-b border-[#1F1F1F] flex flex-col md:flex-row justify-between items-center bg-[#0F0F0F] gap-4 shrink-0">
            <div className="flex flex-wrap gap-2 w-full md:w-auto justify-center md:justify-start">
               <button 
                  onClick={handleSync} 
                  disabled={isSyncing || isProcessing}
                  className="flex items-center justify-center gap-2 bg-[#111] border border-[#1F1F1F] hover:bg-[#1A1A1A] hover:border-[#333] text-white px-4 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 flex-1 md:flex-none whitespace-nowrap"
               >
                  <RefreshCw size={16} className={isSyncing ? "animate-spin text-[#D4AF37]" : "text-[#D4AF37]"} />
                  <span>تحديث الفيديوهات</span>
               </button>
               <button 
                  onClick={() => selectNextBatch(30)} 
                  disabled={isProcessing || videos.length === 0}
                  className="flex items-center justify-center gap-2 bg-[#111] border border-[#1F1F1F] hover:bg-[#1A1A1A] text-white px-4 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 flex-1 md:flex-none whitespace-nowrap"
               >
                  <CheckSquare size={16} className="text-[#888]" />
                  <span>تحديد 30 غير محملة</span>
               </button>
               <button 
                  onClick={clearSelection} 
                  disabled={isProcessing || selectedIds.size === 0}
                  className="flex items-center justify-center gap-2 bg-[#111] border border-[#1F1F1F] hover:bg-[#1A1A1A] text-white px-4 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 flex-1 md:flex-none whitespace-nowrap"
               >
                  <Square size={16} className="text-[#888]" />
                  <span>إلغاء التحديد</span>
               </button>
            </div>
            
            <div className="text-xs text-[#888] font-mono flex items-center gap-4 shrink-0">
               {isSyncing || isProcessing ? (
                  <span className="text-[#D4AF37] animate-pulse hidden md:inline-block">{progressText || 'جاري العمل...'}</span>
               ) : success ? (
                  <span className="text-emerald-500 hidden md:inline-block">{progressText}</span>
               ) : null}
               <div className="bg-[#111] border border-[#1F1F1F] px-3 py-1.5 rounded-md flex gap-2">
                 <span>الإجمالي:</span> <span className="text-white font-bold">{videos.length}</span>
               </div>
               <div className="bg-[#111] border border-[#1F1F1F] px-3 py-1.5 rounded-md flex gap-2">
                 <span>المحدد:</span> <span className="text-[#D4AF37] font-bold">{selectedIds.size}</span>
               </div>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-4 p-4 border-b border-[#1F1F1F] text-[10px] uppercase tracking-widest text-[#666] font-bold bg-[#0A0A0A] shrink-0 text-right pr-6">
             <div className="col-span-1 text-center">تحديد</div>
             <div className="col-span-7">عنوان الفيديو</div>
             <div className="col-span-2 hidden md:block">الرابط</div>
             <div className="col-span-4 md:col-span-2 text-center">الحالة</div>
          </div>

          <div className="flex-1 overflow-y-auto">
             {videos.map((video, index) => (
                <div key={`${video.id}-${index}`} className="grid grid-cols-12 gap-4 p-4 border-b border-[#111] items-center text-sm hover:bg-[#111]/50 transition-colors pr-6 text-right" onClick={() => !isProcessing && toggleSelection(video.id)}>
                   <div className="col-span-1 flex justify-center">
                      <input 
                        type="checkbox" 
                        checked={selectedIds.has(video.id)} 
                        onChange={() => toggleSelection(video.id)}
                        disabled={isProcessing}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 cursor-pointer accent-[#D4AF37] rounded bg-[#1F1F1F] border-[#333]" 
                      />
                   </div>
                   <div className="col-span-7 text-white font-medium truncate select-none cursor-pointer" title={video.title}>{video.title}</div>
                   <div className="col-span-2 text-[#D4AF37] font-mono text-xs truncate hidden md:block" dir="ltr" onClick={(e) => e.stopPropagation()}>
                      <a href={video.url} target="_blank" rel="noreferrer" className="hover:underline">youtu.be/{video.id}</a>
                   </div>
                   <div className="col-span-4 md:col-span-2 text-center flex justify-center">
                      {downloadedIds.has(video.id) ? (
                         <span className="text-emerald-500/90 border border-emerald-900/30 text-[10px] font-bold uppercase bg-emerald-950/30 px-2.5 py-1 rounded-full whitespace-nowrap">محمل</span>
                      ) : (
                         <span className="text-[#666] border border-[#1F1F1F] text-[10px] font-bold uppercase bg-[#0F0F0F] px-2.5 py-1 rounded-full whitespace-nowrap">بانتظار التحميل</span>
                      )}
                   </div>
                </div>
             ))}
             {videos.length === 0 && !isSyncing && (
                <div className="p-16 text-center text-[#666] flex flex-col items-center gap-4">
                   <Youtube size={48} className="text-[#333]" />
                   <p className="text-lg">لا يوجد فيديوهات في القائمة.</p>
                   <button onClick={handleSync} className="text-[#D4AF37] hover:underline text-sm font-medium">اضغط هنا لجلب الفيديوهات من قناتك</button>
                </div>
             )}
          </div>

          <div className="p-4 md:p-6 bg-[#0F0F0F] border-t border-[#1F1F1F] flex justify-center shrink-0">
              {isProcessing ? (
                <div className="w-full max-w-md space-y-3">
                   <div className="flex justify-between items-center text-xs text-[#888] font-mono">
                     <span>{progressPercent}%</span>
                     <span className="truncate ml-4">{progressText}</span>
                   </div>
                   <div className="w-full bg-[#1F1F1F] rounded-full h-2 overflow-hidden shadow-inner">
                     <div 
                       className="bg-[#D4AF37] h-full rounded-full transition-all duration-300 relative overflow-hidden" 
                       style={{ width: `${progressPercent}%` }}
                     >
                       <div className="absolute inset-0 bg-white/20 w-full h-full -skew-x-12 transform -translate-x-full animate-[shimmer_1.5s_infinite]"></div>
                     </div>
                   </div>
                </div>
              ) : (
                  <button 
                    onClick={startDownload} 
                    disabled={selectedIds.size === 0} 
                    className="bg-[#D4AF37] hover:bg-[#C4A137] disabled:bg-[#111] disabled:border-[#1F1F1F] disabled:text-[#666] border border-transparent text-black font-bold py-3 px-8 md:px-12 rounded-full text-sm md:text-base shadow-[0_0_30px_rgba(212,175,55,0.15)] disabled:shadow-none flex items-center justify-center gap-3 transition-all active:scale-95 disabled:active:scale-100"
                  >
                     <Download size={20} />
                     <span>تحميل الفيديوهات المحددة ({selectedIds.size})</span>
                  </button>
              )}
          </div>
        </section>

      </div>
    </div>
  );
}
