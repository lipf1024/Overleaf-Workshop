import { FileSyncRecord } from './model';
import { hasUnresolvedConflict } from './conflictState';

/** Shared status meanings for Explorer badges and Source Control icons. */
export function syncDecoration(record:FileSyncRecord):{badge?:string;color:string;icon:string;tooltip:string}|undefined {
    if (record.suspension==='ignored') { return ignoredDecoration(!!record.base); }
    let badge:string,color:string,icon:string,label:string;
    if (record.suspension) { badge='P'; color='gitDecoration.stageDeletedResourceForeground'; icon='debug-pause'; label='Overleaf: synchronization paused'; }
    else if (hasUnresolvedConflict(record)) { badge='!'; color='gitDecoration.conflictingResourceForeground'; icon='warning'; label='Overleaf: conflict'; }
    else if (record.status==='error') { badge='!'; color='gitDecoration.conflictingResourceForeground'; icon='error'; label='Overleaf: synchronization failed'; }
    else if (record.status==='pending-upload' || record.status==='local-changed') {
        const added=!record.base;
        badge=added?'A':'M'; color=added?'gitDecoration.addedResourceForeground':'gitDecoration.modifiedResourceForeground'; icon='cloud-upload';
        label=added?'Overleaf: new file, pending upload':'Overleaf: local changes, pending upload';
    } else if (record.status==='pending-download' || record.status==='remote-changed') {
        badge='↓'; color='gitDecoration.modifiedResourceForeground'; icon='cloud-download'; label='Overleaf: remote changes, pending download';
    } else if (record.status==='syncing') {
        badge='↔'; color='gitDecoration.modifiedResourceForeground'; icon='sync'; label='Overleaf: synchronizing';
    } else { return; }
    return {badge,color,icon,tooltip:label+(record.message?'. '+record.message:'')};
}

/** Ignored children must not make an otherwise synchronized parent folder gray. */
export function ignoredDecoration(previouslySynced=false):{badge?:string;color:string;icon:string;tooltip:string} {
    return {badge:previouslySynced?'Ⅱ':undefined,color:'gitDecoration.ignoredResourceForeground',icon:'debug-pause',
        tooltip:previouslySynced
            ? 'Overleaf: synchronization stopped; existing files are retained, and local and remote content may differ'
            : 'Overleaf: ignored; does not participate in synchronization'};
}
