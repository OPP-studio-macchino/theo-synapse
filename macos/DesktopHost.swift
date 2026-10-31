import Foundation
import AppKit
import CryptoKit
import Darwin

struct HostError: LocalizedError { let message:String; var errorDescription:String? {message} }
struct ProcessResult { let code:Int32; let out:String; let err:String }
struct CoreManifest:Decodable { struct Entry:Decodable {let path:String;let bytes:Int;let sha256:String}; let schema:Int;let files:[Entry] }
struct SnapshotPlan:Decodable,Identifiable {
 struct Excluded:Decodable {let unsupported:Int;let protected:Int;let symlink:Int;let oversized:Int;let binary:Int;let unsafe:Int}
 struct File:Decodable,Identifiable {let path:String;let bytes:Int;var id:String{path}}
 let operation:String,id:String,source:String,displayName:String,digest:String,fingerprint:String
 let eligibleFiles:Int,totalBytes:Int,excluded:Excluded,sourceChanged:Bool,files:[File]
}
struct DirectWorkspacePlan:Decodable,Identifiable {
 let operation:String,id:String,source:String,fingerprint:String,createdAt:Int64,expiresAt:Int64,confirmation:String,sourceChanged:Bool
}

// This app manages only byte-for-byte-owned LaunchAgents. It never adopts a
// process that happens to use the private socket.
final class DesktopHost {
 static let readonlyLabel="tech.oppstudio.theosynapse.desktop.readonly"
 static let directLabel="tech.oppstudio.theosynapse.desktop.direct"
 let fm=FileManager.default, home=FileManager.default.homeDirectoryForCurrentUser
 let resources=Bundle.main.resourceURL!
 var base:URL {home.appendingPathComponent("Library/Application Support/Theo Synapse",isDirectory:true)}
 var core:URL {base.appendingPathComponent("core",isDirectory:true)}
 var runtime:URL {core.appendingPathComponent(".local/theo-runtime",isDirectory:true)}
 func plist(_ label:String)->URL {home.appendingPathComponent("Library/LaunchAgents/\(label).plist")}
 var domain:String {"gui/\(getuid())"};func service(_ label:String)->String {"\(domain)/\(label)"}
 var installed:Bool {fm.fileExists(atPath:core.path)}
 var env:[String:String] {["HOME":home.path,"PATH":home.appendingPathComponent(".local/bin").path+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin","LANG":"ja_JP.UTF-8"]}
 func fail(_ text:String)->HostError {HostError(message:text)}
 func run(_ executable:String,_ args:[String],cwd:URL?=nil,timeout:TimeInterval=15)throws->ProcessResult {
  let p=Process(),o=Pipe(),e=Pipe();p.executableURL=URL(fileURLWithPath:executable);p.arguments=args;p.environment=env;p.currentDirectoryURL=cwd;p.standardOutput=o;p.standardError=e;p.standardInput=FileHandle.nullDevice
  let wait=DispatchSemaphore(value:0);p.terminationHandler={_ in wait.signal()};try p.run()
  if wait.wait(timeout:.now()+timeout) == .timedOut {p.terminate();if wait.wait(timeout:.now()+2) == .timedOut {kill(p.processIdentifier,SIGKILL);_ = wait.wait(timeout:.now()+2)};throw fail("処理が時間内に完了しませんでした。自動再試行はしません。")}
  let a=o.fileHandleForReading.readDataToEndOfFile(),b=e.fileHandleForReading.readDataToEndOfFile()
  guard a.count<131072,b.count<131072 else {throw fail("診断出力が上限を超えました。")}
  return ProcessResult(code:p.terminationStatus,out:String(decoding:a,as:UTF8.self),err:String(decoding:b,as:UTF8.self))
 }
 func regular(_ url:URL,privateOnly:Bool=false)throws {
  let a=try fm.attributesOfItem(atPath:url.path),mode=(a[.posixPermissions] as? NSNumber)?.intValue ?? 0
  guard a[.type] as? FileAttributeType == .typeRegular,(a[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),(a[.referenceCount] as? NSNumber)?.intValue==1,(!privateOnly||mode&0o077==0) else {throw fail("ファイルの所有者・種類・アクセス権が不正です。")}
 }
 func privateDirectory(_ url:URL,create:Bool=false)throws {
  if !fm.fileExists(atPath:url.path) {guard create else {throw fail("初期設定が必要です。")};try fm.createDirectory(at:url,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])}
  let a=try fm.attributesOfItem(atPath:url.path)
  guard a[.type] as? FileAttributeType == .typeDirectory,(a[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),((a[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o077==0,url.resolvingSymlinksInPath().path==url.path else {throw fail("専用フォルダの所有者・権限・パスが不正です。")}
 }
 func node()throws->String {
  for path in [home.appendingPathComponent(".local/bin/node").path,"/opt/homebrew/bin/node","/usr/local/bin/node"] where fm.isExecutableFile(atPath:path) {
   let real=URL(fileURLWithPath:path).resolvingSymlinksInPath(),a=try fm.attributesOfItem(atPath:URL(fileURLWithPath:path).resolvingSymlinksInPath().path)
   let uid=(a[.ownerAccountID] as? NSNumber)?.uint32Value,mode=(a[.posixPermissions] as? NSNumber)?.intValue ?? 0
   guard a[.type] as? FileAttributeType == .typeRegular,(uid==getuid()||uid==0),mode&0o022==0 else {continue}
   let r=try run(real.path,["--version"],timeout:5),v=r.out.trimmingCharacters(in:.whitespacesAndNewlines).dropFirst().split(separator:".").first.flatMap{Int($0)} ?? 0
   if r.code==0 && v>=24 {return real.path}
  }
  throw fail("Node.js 24以上が見つかりません。導入済みのNode.jsを確認してください。勝手にインストールはしません。")
 }
 func verifyCore()throws {
  try privateDirectory(base);try privateDirectory(core)
  let m=try JSONDecoder().decode(CoreManifest.self,from:Data(contentsOf:resources.appendingPathComponent("core-manifest.json")))
  guard m.schema==1 else {throw fail("アプリの構成が不正です。")}
  var allowed=Set<String>()
  for x in m.files {
   guard !x.path.hasPrefix("/"),!x.path.split(separator:"/").contains(".."),!x.path.contains("\\"),!x.path.hasPrefix(".local/") else {throw fail("manifestのパスが不正です。")}
   let f=core.appendingPathComponent(x.path);try regular(f)
   guard f.resolvingSymlinksInPath().path==f.path else {throw fail("実行ファイルにリンクが混入しています。")}
   let b=try Data(contentsOf:f),h=SHA256.hash(data:b).map{String(format:"%02x",$0)}.joined()
   guard b.count==x.bytes,h==x.sha256 else {throw fail("コードの整合性検査に失敗しました。上書き修復はしません。")};allowed.insert(x.path)
  }
  guard let it=fm.enumerator(at:core,includingPropertiesForKeys:[.isRegularFileKey,.isSymbolicLinkKey]) else {throw fail("実行フォルダを検査できません。")}
  for case let f as URL in it {
   let rel=String(f.path.dropFirst(core.path.count+1));if rel==".local" {it.skipDescendants();continue}
   let v=try f.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey])
   if v.isSymbolicLink==true || (v.isRegularFile==true && !allowed.contains(rel)) {throw fail("許可されていないコードファイルを検出しました。")}
  }
 }
 func snapshotID(_ id:String)throws {
  guard id.range(of:"^[A-Za-z][A-Za-z0-9_-]{2,39}$",options:.regularExpression) != nil,id != "theo-lab" else {throw fail("IDは英字で始まる3〜40文字の半角英数字・ハイフン・アンダースコアにしてください。")}
  guard id != "chappy-signal" else {throw fail("chappy-signal は旧Standalone専用です。Mac版には登録・取込できません。")}
 }
 func directID(_ id:String)throws {try snapshotID(id)}
 func snapshotSource(_ path:String)throws->URL {
  guard path.utf8.count<=320,!path.unicodeScalars.contains(where:{$0.value<32}) else {throw fail("選択したフォルダのパスが安全ではありません。")}
  let url=URL(fileURLWithPath:path,isDirectory:true).standardizedFileURL
  guard url.path.hasPrefix("/"),url.path==path,url.resolvingSymlinksInPath().path==path else {throw fail("シンボリックリンクや別名のフォルダは選択できません。実体のフォルダを選んでください。")}
  let v=try url.resourceValues(forKeys:[.isDirectoryKey,.isSymbolicLinkKey])
  let a=try fm.attributesOfItem(atPath:path)
  guard v.isDirectory==true,v.isSymbolicLink != true,(a[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),((a[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o022==0 else {throw fail("選択したフォルダの所有者または書き込み権限が安全ではありません。")}
  return url
 }
 func projectScript()throws->URL {
  try verifyCore()
  let script=core.appendingPathComponent("scripts/theo-projects.mjs")
  guard script.path==core.path+"/scripts/theo-projects.mjs",script.resolvingSymlinksInPath().path==script.path else {throw fail("プロジェクト取込コードのパスが不正です。")}
  try regular(script);return script
 }
 func projectFailure(_ result:ProcessResult)->HostError {
  let code=result.err.split(whereSeparator:{$0.isWhitespace}).last.map(String.init) ?? "OWNER_PROJECT_OPERATION_FAILED"
  let messages=[
   "PROJECT_ID_ALREADY_REGISTERED":"同じIDはすでに登録されています。別のIDを指定してください。",
   "ACTIVE_JOBS_BLOCK_IMPORT":"実行中または待機中の作業があります。完了後にもう一度プレビューしてください。",
   "SOURCE_SECRETS_DETECTED":"秘密情報らしい内容を検出したため中止しました。元フォルダを確認してください。",
   "OWNER_CONFIRMATION_REQUIRED":"プレビュー後に元フォルダの内容が変わりました。もう一度プレビューしてください。",
   "OWNER_NATIVE_APPROVAL_DENIED":"Ownerの許可が得られなかったため、コピーしませんでした。",
   "SOURCE_ALIAS_DENIED":"シンボリックリンクや別名のフォルダは選択できません。",
   "SOURCE_DIRECTORY_UNSAFE":"フォルダの所有者または権限が安全ではありません。",
   "SNAPSHOT_NO_ELIGIBLE_FILES":"読み取り対象にできるファイルがありません。",
   "FORBIDDEN_NATIVE_PROJECT":"chappy-signal は旧Standalone専用です。Mac版には登録・取込できません。"
  ]
  return fail(messages[code] ?? "安全検査に失敗しました（\(code)）。原本は変更していません。")
 }
 func planSnapshot(id:String,path:String)throws->SnapshotPlan {
  try snapshotID(id);let source=try snapshotSource(path),script=try projectScript()
  let r=try run(try node(),[script.path,"plan",id,source.path],cwd:core,timeout:30)
  guard r.code==0 else {throw projectFailure(r)}
  do{return try JSONDecoder().decode(SnapshotPlan.self,from:Data(r.out.utf8))}catch{throw fail("プレビュー結果を安全に読み取れませんでした。")}
 }
 func importSnapshot(id:String,path:String,confirm:String)throws->[String:Any] {
  try snapshotID(id);guard confirm.range(of:"^[a-f0-9]{20}$",options:.regularExpression) != nil else {throw fail("確認番号が不正です。もう一度プレビューしてください。")}
  let source=try snapshotSource(path),script=try projectScript()
  let r=try run(try node(),[script.path,"import",id,source.path,confirm],cwd:core,timeout:140)
  guard r.code==0 else {throw projectFailure(r)}
  guard let result=try? JSONSerialization.jsonObject(with:Data(r.out.utf8)) as? [String:Any],result["registered"] as? Bool==true,result["sourceChanged"] as? Bool==false else {throw fail("取込完了を検証できませんでした。自動再試行はしません。")}
  return try inspect(login:false)
 }
 func directScript()throws->URL {
  try verifyCore();let script=core.appendingPathComponent("scripts/theo-direct-workspaces.mjs")
  guard script.path==core.path+"/scripts/theo-direct-workspaces.mjs",script.resolvingSymlinksInPath().path==script.path else {throw fail("direct登録コードのパスが不正です。")}
  try regular(script);return script
 }
 func directFailure(_ result:ProcessResult)->HostError {
  let code=result.err.split(whereSeparator:{$0.isWhitespace}).last.map(String.init) ?? "DIRECT_WORKSPACE_OPERATION_FAILED"
  let messages=["DIRECT_WORKSPACE_ID_DENIED":"theo-lab と chappy-signal はdirect書き込みに登録できません。","DIRECT_WORKSPACE_RESERVED_PATH":"theo-lab と chappy-signal はdirect書き込みに登録できません。","DIRECT_WORKSPACE_ALIAS_DENIED":"シンボリックリンクや別名のフォルダは選択できません。","DIRECT_PLAN_EXPIRED":"確認番号の有効期限（5分）が切れました。もう一度プレビューしてください。","DIRECT_OWNER_CONFIRMATION_REQUIRED":"確認番号が一致しません。もう一度プレビューしてください。","DIRECT_OWNER_APPROVAL_DENIED":"Ownerの許可が得られなかったため登録しませんでした。","ACTIVE_JOBS_BLOCK_DIRECT_REGISTRATION":"実行中または待機中の作業があるため登録しません。"]
  return fail(messages[code] ?? "direct登録の安全検査に失敗しました（\(code)）。")
 }
 func planDirectWorkspace(id:String,path:String)throws->DirectWorkspacePlan {
  try directID(id);let source=try snapshotSource(path),script=try directScript()
  let r=try run(try node(),[script.path,"plan",id,source.path],cwd:core,timeout:30)
  guard r.code==0 else {throw directFailure(r)}
  guard let plan=try? JSONDecoder().decode(DirectWorkspacePlan.self,from:Data(r.out.utf8)),plan.operation=="OWNER_DIRECT_WORKSPACE_REVIEW",plan.sourceChanged==false,plan.expiresAt-plan.createdAt==300000 else {throw fail("directプレビュー結果を安全に読み取れませんでした。")};return plan
 }
 func registerDirectWorkspace(_ plan:DirectWorkspacePlan)throws->[String:Any] {
  guard Int64(Date().timeIntervalSince1970*1000)<=plan.expiresAt,plan.confirmation.range(of:"^[a-f0-9]{20}$",options:.regularExpression) != nil else {throw fail("確認番号の有効期限（5分）が切れました。もう一度プレビューしてください。")}
  let source=try snapshotSource(plan.source),script=try directScript()
  let r=try run(try node(),[script.path,"register",plan.id,source.path,plan.confirmation,String(plan.createdAt)],cwd:core,timeout:100)
  guard r.code==0 else {throw directFailure(r)}
  guard let result=try? JSONSerialization.jsonObject(with:Data(r.out.utf8)) as? [String:Any],result["registered"] as? Bool==true,result["sourceChanged"] as? Bool==false else {throw fail("direct登録完了を検証できませんでした。自動再試行はしません。")};return try inspect(login:false)
 }
 func setup()throws->[String:Any] {
  _ = try node();if installed {try verifyCore();return try inspect(login:true)}
  try privateDirectory(base,create:true)
  let staging=base.appendingPathComponent("core-install-"+UUID().uuidString,isDirectory:true)
  try fm.copyItem(at:resources.appendingPathComponent("Core",isDirectory:true),to:staging)
  defer{if fm.fileExists(atPath:staging.path){try? fm.removeItem(at:staging)}}
  try fm.setAttributes([.posixPermissions:0o700],ofItemAtPath:staging.path)
  if let it=fm.enumerator(at:staging,includingPropertiesForKeys:[.isDirectoryKey]) {for case let f as URL in it {let d=try f.resourceValues(forKeys:[.isDirectoryKey]).isDirectory==true;try fm.setAttributes([.posixPermissions:d ? 0o700:0o600],ofItemAtPath:f.path)}}
  try fm.moveItem(at:staging,to:core);try verifyCore()
  let r=try run(try node(),[core.appendingPathComponent("scripts/setup-readonly-lab.mjs").path],cwd:core)
  guard r.code==0 else {throw fail("読み取り専用デモの初期設定に失敗しました。")}
  return try inspect(login:true)
 }
 func inspect(login:Bool=false)throws->[String:Any] {
  var v:[String:Any]=["installed":installed,"running":false,"mode":"stopped","hostState":"STOPPED","readOnly":true,"writeEnabled":false,"appVersion":(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "UNKNOWN"),"corePath":core.path,"chatGPTConnection":"UNVERIFIED"]
  guard installed else {return v}
  try privateDirectory(base);try privateDirectory(core)
  var args=[core.appendingPathComponent("scripts/desktop-inspect.mjs").path];if login{args.append("--login")}
  let r=try run(try node(),args,cwd:core)
  guard r.code==0,let o=try JSONSerialization.jsonObject(with:Data(r.out.utf8)) as? [String:Any],o["error"]==nil else {throw fail("ローカル状態を確認できません。初期設定・ログを確認してください。")}
  v.merge(o){_,new in new}
  let readonly=try run("/bin/launchctl",["print",service(Self.readonlyLabel)],timeout:5),direct=try run("/bin/launchctl",["print",service(Self.directLabel)],timeout:5)
  let readonlyPID=agentPID(readonly.out),directPID=agentPID(direct.out),readonlyLive=readonlyPID.map(processAlive) ?? false,directLive=directPID.map(processAlive) ?? false
  v["readonlyLaunchAgentLoaded"]=readonly.code==0 && readonlyLive;v["directLaunchAgentLoaded"]=direct.code==0 && directLive
  let mode=v["mode"] as? String ?? "stopped",managed=(mode=="read_only" && readonlyLive && ownedAgent(Self.readonlyLabel,entry:"scripts/task-daemon-entry.mjs")) || (mode=="direct" && directLive && ownedAgent(Self.directLabel,entry:"scripts/theo-direct-daemon-entry.mjs"))
  v["launchAgentLoaded"]=managed;v["hostState"]=mode=="stopped" ? "STOPPED" : (managed ? (mode=="direct" ? "DIRECT(10)":"READONLY(8)") : "UNMANAGED/UNKNOWN")
  if mode=="read_only",let pid=readonlyPID {v["pid"]=pid};if mode=="direct",let pid=directPID {v["pid"]=pid}
  return v
 }
 func agentPID(_ text:String)->Int? {guard let s=text.split(separator:"\n").first(where:{$0.trimmingCharacters(in:.whitespaces).hasPrefix("pid = ")}) else{return nil};return Int(s.split(separator:"=").last!.trimmingCharacters(in:.whitespaces))}
 func processAlive(_ pid:Int)->Bool {pid>1 && (kill(pid_t(pid),0)==0 || errno==EPERM)}
 func agentData(_ label:String,_ binary:String)throws->Data {
  let direct=label==Self.directLabel,entry=direct ? "scripts/theo-direct-daemon-entry.mjs":"scripts/task-daemon-entry.mjs",prefix=direct ? "desktop-direct":"desktop"
  let d:[String:Any]=["Label":label,"ProgramArguments":[binary,core.appendingPathComponent(entry).path],"WorkingDirectory":core.path,"RunAtLoad":true,"KeepAlive":false,"ThrottleInterval":20,"Umask":63,"EnvironmentVariables":env,"StandardOutPath":runtime.appendingPathComponent("\(prefix).stdout.log").path,"StandardErrorPath":runtime.appendingPathComponent("\(prefix).stderr.log").path]
  return try PropertyListSerialization.data(fromPropertyList:d,format:.xml,options:0)
 }
 func ownedAgent(_ label:String,entry:String)->Bool {guard let binary=try? node(),fm.fileExists(atPath:plist(label).path),let data=try? agentData(label,binary),let current=try? Data(contentsOf:plist(label)) else{return false};return current==data}
 func ownedFile(_ label:String)throws->Bool {
  let file=plist(label);guard fm.fileExists(atPath:file.path) else{return false};try regular(file,privateOnly:true)
  guard try Data(contentsOf:file)==agentData(label,try node()) else {throw fail("管理外または変更された自動起動設定には操作しません。")};return true
 }
 func agentLoaded(_ label:String)throws->Bool {try run("/bin/launchctl",["print",service(label)],timeout:5).code==0}
 func waitInactive(_ label:String)throws {
  for _ in 0..<15 {let r=try run("/bin/launchctl",["print",service(label)],timeout:5);if r.code != 0 && !(agentPID(r.out).map(processAlive) ?? false){return};Thread.sleep(forTimeInterval:0.2)}
  throw fail("停止後も自動起動サービスが残っています。再起動しません。")
 }
 func removeOwnedFile(_ label:String)throws {guard try ownedFile(label) else{return};try fm.removeItem(at:plist(label))}
 func prepareExclusive(_ label:String)throws {
  let other=label==Self.directLabel ? Self.readonlyLabel:Self.directLabel
  let targetOwned=try ownedFile(label),otherOwned=try ownedFile(other)
  let targetLoaded=try agentLoaded(label),otherLoaded=try agentLoaded(other)
  if targetLoaded && otherLoaded {throw fail("READONLY と DIRECT の二重自動起動状態を検出しました。設定を変更しません。")}
  if targetLoaded {guard targetOwned else {throw fail("管理外の自動起動サービスには操作しません。")};guard try run("/bin/launchctl",["bootout",service(label)],timeout:12).code==0 else {throw fail("既存サービスを停止できません。")};try waitInactive(label)}
  if otherLoaded {guard otherOwned else {throw fail("管理外または別モードのプロセスには操作しません。")};guard try run("/bin/launchctl",["bootout",service(other)],timeout:12).code==0 else {throw fail("別モードのサービスを停止できません。")};try waitInactive(other)}
  if otherOwned {try removeOwnedFile(other)}
 }
 func installAgentFile(_ label:String)throws {
  let file=plist(label),parent=file.deletingLastPathComponent()
  if !fm.fileExists(atPath:parent.path){try fm.createDirectory(at:parent,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])}
  let a=try fm.attributesOfItem(atPath:parent.path)
  guard a[.type] as? FileAttributeType == .typeDirectory,parent.resolvingSymlinksInPath().path==parent.path,(a[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),((a[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o022==0 else {throw fail("LaunchAgentsフォルダの権限が不正です。")}
  let d=try agentData(label,try node())
  if fm.fileExists(atPath:file.path){try regular(file,privateOnly:true);guard try Data(contentsOf:file)==d else {throw fail("同名の自動起動設定が存在します。上書きはしません。")}}
  else {try d.write(to:file,options:.withoutOverwriting);try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)}
  guard try run("/usr/bin/plutil",["-lint",file.path]).code==0 else {throw fail("自動起動設定の検査に失敗しました。")}
 }
 func start(_ label:String,mode:String)throws->[String:Any] {
  guard installed else {throw fail("先に「初期設定」を押してください。")};try verifyCore();let s=try inspect()
  if s["running"] as? Bool == true {guard s["launchAgentLoaded"] as? Bool == true else {throw fail("管理外または別モードのプロセスには操作しません。")};if (s["mode"] as? String)==mode{return s};let other=(s["mode"] as? String)=="direct" ? Self.directLabel:Self.readonlyLabel;_ = try stop(other,mode:s["mode"] as! String)}
  guard (s["activeTasks"] as? Int ?? 0)==0 else {throw fail("未完了タスクがあります。自動再実行はしません。")}
  guard mode != "direct" || !(s["directWorkspaces"] as? [String] ?? []).isEmpty else {throw fail("Owner承認済みのdirect作業フォルダを先に登録してください。")}
  try prepareExclusive(label)
  try installAgentFile(label)
  guard try run("/bin/launchctl",["bootstrap",domain,plist(label).path],timeout:12).code==0 else {throw fail("macOSが登録を許可しませんでした。システム設定のログイン項目を確認してください。")}
  for _ in 0..<15{Thread.sleep(forTimeInterval:0.25);let s=try inspect();if s["running"] as? Bool == true,(s["mode"] as? String)==mode,(s["launchAgentLoaded"] as? Bool)==true{return s}}
  throw fail("サービス起動後に応答がありません。ログを確認してください。")
 }
 func stop(_ label:String,mode:String)throws->[String:Any] {
  let s=try inspect();guard s["installed"] as? Bool == true else {return s}
  guard (s["activeTasks"] as? Int ?? 0)==0 else {throw fail("作業中のため停止しません。終了後に操作してください。")}
  guard (s["mode"] as? String) != "direct" || (s["directActiveRuns"] as? Int ?? 0)==0 else {throw fail("direct作業中のため停止しません。")}
  if s["launchAgentLoaded"] as? Bool != true || (s["mode"] as? String) != mode {if s["running"] as? Bool == true {throw fail("管理外または別モードのプロセスは停止できません。")};return s}
  guard try ownedFile(label) else {throw fail("自動起動設定が見つかりません。")}
  guard try run("/bin/launchctl",["bootout",service(label)],timeout:12).code==0 else {throw fail("macOSから停止完了を確認できませんでした。")}
  try waitInactive(label)
  for _ in 0..<15{Thread.sleep(forTimeInterval:0.2);let v=try inspect();if v["running"] as? Bool != true && v["launchAgentLoaded"] as? Bool != true {if mode=="direct" {try removeOwnedFile(label)};return try inspect()}}
  throw fail("停止後も応答があります。再起動しません。")
 }
 func startDirectAfterOwnerApproval()throws->[String:Any] {return try start(Self.directLabel,mode:"direct")}
 func action(_ command:String)throws->[String:Any] {
  switch command {
  case "setup":return try setup()
  case "status":return try inspect(login:true)
  case "start":return try start(Self.readonlyLabel,mode:"read_only")
  case "stop":return try stop(Self.readonlyLabel,mode:"read_only")
  case "restart":_ = try stop(Self.readonlyLabel,mode:"read_only");return try start(Self.readonlyLabel,mode:"read_only")
  case "direct-stop":return try stop(Self.directLabel,mode:"direct")
  case "verify":try verifyCore();return ["verdict":"PASS","writeEnabled":false]
  case "smoke":
   try verifyCore();let r=try run(try node(),[core.appendingPathComponent("scripts/desktop-smoke.mjs").path],cwd:core,timeout:20)
   guard r.code==0,let v=try JSONSerialization.jsonObject(with:Data(r.out.utf8)) as? [String:Any] else {throw fail("接続診断に失敗しました。")};return v
  default:throw fail("許可されていない操作です。")
  }
 }
}
