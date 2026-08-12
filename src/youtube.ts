export async function getUploadsPlaylistId(token: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(parseApiError(data.error.message));
  
  if (data.items && data.items.length > 0) {
    return data.items[0].contentDetails.relatedPlaylists.uploads;
  }
  throw new Error('لم يتم العثور على قناة لهذا الحساب.');
}

function parseApiError(msg: string): string {
  const plainText = msg.replace(/<[^>]+>/g, '');
  if (plainText.toLowerCase().includes('quota')) {
    return 'لقد تجاوزت الحد المسموح به لطلبات واجهة يوتيوب (Quota) لهذا اليوم. تضع يوتيوب حداً أقصى للطلبات اليومية، يرجى المحاولة مرة أخرى غداً.';
  }
  if (plainText.toLowerCase().includes('unauthorized') || plainText.toLowerCase().includes('invalid credentials') || plainText.toLowerCase().includes('auth')) {
    return 'انتهت صلاحية جلسة يوتيوب. يرجى المحاولة مرة أخرى لتجديد الإذن.';
  }
  return plainText;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  url: string;
}

export async function syncVideos(token: string, playlistId: string, existingVideoIds: Set<string>, onProgress?: (count: number) => void): Promise<YouTubeVideo[]> {
  const newVideos: YouTubeVideo[] = [];
  let pageToken: string | undefined = undefined;
  let keepFetching = true;

  do {
    let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.error) {
      const parsedError = parseApiError(data.error.message);
      if (parsedError.includes('Quota') || parsedError.includes('الحد المسموح')) {
         if (newVideos.length > 0) return newVideos;
      }
      throw new Error(parsedError);
    }

    for (const item of data.items || []) {
      const videoId = item.snippet.resourceId.videoId;
      if (existingVideoIds.has(videoId)) {
        keepFetching = false;
        break;
      }
      newVideos.push({
        id: videoId,
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${videoId}`
      });
    }

    if (onProgress) {
      onProgress(newVideos.length);
    }

    pageToken = data.nextPageToken;
  } while (pageToken && keepFetching);

  return newVideos;
}

export async function getAllVideos(token: string, playlistId: string, onProgress?: (count: number) => void): Promise<YouTubeVideo[]> {
  const videos: YouTubeVideo[] = [];
  let pageToken: string | undefined = undefined;

  do {
    let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.error) {
      const parsedError = parseApiError(data.error.message);
      if (parsedError.includes('Quota') || parsedError.includes('الحد المسموح')) {
         // Return what we have so far if we hit quota limit, but don't fail completely
         if (videos.length > 0) return videos;
      }
      throw new Error(parsedError);
    }

    for (const item of data.items || []) {
      const videoId = item.snippet.resourceId.videoId;
      videos.push({
        id: videoId,
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${videoId}`
      });
    }

    if (onProgress) {
      onProgress(videos.length);
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return videos;
}

export interface CaptionTrack {
  id: string;
  language: string;
  trackKind: string;
  name: string;
}

export async function getVideoCaptions(token: string, videoId: string): Promise<CaptionTrack[]> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(parseApiError(data.error.message));

  return (data.items || []).map((item: any) => ({
    id: item.id,
    language: item.snippet.language,
    trackKind: item.snippet.trackKind,
    name: item.snippet.name
  }));
}

export async function downloadCaptionTrack(token: string, captionId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/captions/${captionId}?tfmt=srt`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`فشل تحميل الترجمة: ${res.statusText}`);
  }
  return await res.text();
}
