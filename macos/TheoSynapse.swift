import Foundation
import AppKit
import SwiftUI

@MainActor final class ViewModel:ObservableObject {
 @Published var busy=false
 @Published var installed=false
 @Published var running=false
 @Published var codex=false
 @Published var error=false
 @Published var projects="未設定"
 @Published var login="未確認"
 @Published var chatGPTConnection="ローカル状態のみ（ChatGPT接続は未確認）"
 @Published var message="初期設定で、このMac専用の安全な実行環境を作ります。"
 @Published var projectBusy=false
 @Published var projectID=""
 @Published var snapshotPlan:SnapshotPlan?
 @Published var directPlan:DirectWorkspacePlan?
 @Published var directProjects="未設定"
 @Published var hostState="STOPPED"
 func perform(_ command:String){
  guard !busy else{return};busy=true;error=false
  DispatchQueue.global(qos:.userInitiated).async {
   do {
    let r=try DesktopHost().action(command)
    DispatchQueue.main.async {
     self.installed=r["installed"] as? Bool ?? self.installed;self.running=r["running"] as? Bool ?? self.running;self.hostState=r["hostState"] as? String ?? self.hostState
     self.codex=r["codexInstalled"] as? Bool ?? self.codex
     if let p=r["registeredProjects"] as? [String]{self.projects=p.joined(separator:"、")}
     if let p=r["directWorkspaces"] as? [String]{self.directProjects=p.isEmpty ? "未設定":p.joined(separator:"、")}
     if let l=r["codexLogin"] as? String,l != "NOT_CHECKED" {self.login=l=="LOGGED_IN" ? "ログイン済み":"ログインが必要"}
     if let status=r["chatGPTConnection"] as? String {self.chatGPTConnection=status=="UNVERIFIED" ? "ローカル状態のみ（ChatGPT接続は未確認）":"ローカル状態のみ"}
     let texts=["setup":"初期設定が完了しました。「起動」でサービスを開始できます。","start":"READONLY(8) サービスを起動しました。","stop":"停止しました。Macへの次回ログイン時には自動起動します。","direct-stop":"DIRECT(10) サービスを停止し、自動起動も解除しました。","restart":"再起動し、応答を確認しました。","status":"現在の状態を確認しました。","verify":"実行コードの整合性を確認しました。","smoke":"現在のモードのMCPツール数を確認しました。モデルの作業実行は行っていません。"]
     self.message=texts[command] ?? "完了しました。";self.busy=false
    }
   }catch{let text=error.localizedDescription;DispatchQueue.main.async {self.message=text;self.error=true;self.busy=false}}
  }
 }
 func chooseDirectFolder(){
  guard !busy && !projectBusy else{return}
  do{try DesktopHost().directID(projectID)}catch{message=error.localizedDescription;self.error=true;return}
  let panel=NSOpenPanel();panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false;panel.canCreateDirectories=false;panel.prompt="directを確認"
  panel.message="実際に書き込むdirect作業フォルダを検査します。選択・プレビューだけでは登録も変更も行いません。"
  guard panel.runModal() == .OK,let url=panel.url else{return}
  projectBusy=true;error=false;message="direct作業フォルダを検査中です。まだ登録も変更もしていません。"
  let id=projectID,path=url.path
  DispatchQueue.global(qos:.userInitiated).async {do{let plan=try DesktopHost().planDirectWorkspace(id:id,path:path);DispatchQueue.main.async{self.directPlan=plan;self.projectBusy=false;self.message="directプレビューを確認してください。確認番号は5分だけ有効です。"}}catch{let text=error.localizedDescription;DispatchQueue.main.async{self.message=text;self.error=true;self.projectBusy=false}}}
 }
 func registerDirect(_ plan:DirectWorkspacePlan){
  guard !busy && !projectBusy else{return};projectBusy=true;error=false;message="Owner確認を待っています。許可された場合だけ実フォルダをdirect対象として登録します。"
  DispatchQueue.global(qos:.userInitiated).async {do{let r=try DesktopHost().registerDirectWorkspace(plan);DispatchQueue.main.async{if let p=r["directWorkspaces"] as? [String]{self.directProjects=p.joined(separator:"、")};self.directPlan=nil;self.projectID="";self.projectBusy=false;self.message="direct作業フォルダを登録しました。ここでは原本を変更していません。"}}catch{let text=error.localizedDescription;DispatchQueue.main.async{self.message=text;self.error=true;self.projectBusy=false}}}
 }
 func startDirect(){
  guard !busy && !running else{return}
  let alert=NSAlert();alert.messageText="DIRECT(10) サービスを起動しますか？";alert.informativeText="Owner承認済みの実フォルダに対するdirect作業を受け付けます。各書き込み作業ではさらに1回だけ確認します。30秒で拒否されます。";alert.alertStyle = .warning;alert.addButton(withTitle:"許可しない");alert.addButton(withTitle:"起動を許可")
  guard let window=NSApp.keyWindow else {message="Owner確認用のウインドウを開けません。directは起動しません。";error=true;return}
  let timeout=DispatchWorkItem {window.endSheet(alert.window,returnCode:.alertFirstButtonReturn)}
  DispatchQueue.main.asyncAfter(deadline:.now()+30,execute:timeout)
  alert.beginSheetModal(for:window){response in timeout.cancel();guard response == .alertSecondButtonReturn else {self.message="DIRECT(10) サービスの起動を許可しませんでした。";return};self.launchApprovedDirect()}
 }
 func launchApprovedDirect(){
  busy=true;error=false;DispatchQueue.global(qos:.userInitiated).async {do{let r=try DesktopHost().startDirectAfterOwnerApproval();DispatchQueue.main.async{self.installed=r["installed"] as? Bool ?? self.installed;self.running=r["running"] as? Bool ?? self.running;self.hostState=r["hostState"] as? String ?? self.hostState;self.message="Owner承認済みdirectサービスを起動しました。";self.busy=false}}catch{let text=error.localizedDescription;DispatchQueue.main.async{self.message=text;self.error=true;self.busy=false}}}
 }
 func stopDirect(){perform("direct-stop")}
 func chooseProjectFolder(){
  guard !busy && !projectBusy else{return}
  do{try DesktopHost().snapshotID(projectID)}catch{message=error.localizedDescription;self.error=true;return}
  let panel=NSOpenPanel();panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false;panel.canCreateDirectories=false;panel.prompt="プレビュー"
  panel.message="読み取り専用コピーの候補を安全検査します。この操作だけでは取込も原本の変更も行いません。"
  guard panel.runModal() == .OK,let url=panel.url else{return}
  projectBusy=true;error=false;message="候補ファイルを検査中です。まだコピーしていません。"
  let id=projectID,path=url.path
  DispatchQueue.global(qos:.userInitiated).async{
   do{let plan=try DesktopHost().planSnapshot(id:id,path:path);DispatchQueue.main.async{self.snapshotPlan=plan;self.projectBusy=false;self.message="プレビューを確認してください。まだコピーしていません。"}}
   catch{let text=error.localizedDescription;DispatchQueue.main.async{self.message=text;self.error=true;self.projectBusy=false}}
  }
 }
 func importProject(_ plan:SnapshotPlan){
  guard !busy && !projectBusy else{return};projectBusy=true;error=false
  message="Owner確認を待っています。許可後にだけMac内へ読み取り専用コピーを作ります（最大約2分）。"
  DispatchQueue.global(qos:.userInitiated).async{
   do{let r=try DesktopHost().importSnapshot(id:plan.id,path:plan.source,confirm:plan.fingerprint);DispatchQueue.main.async{
    if let p=r["registeredProjects"] as? [String]{self.projects=p.joined(separator:"、")}
    self.snapshotPlan=nil;self.projectID="";self.projectBusy=false;self.message="読み取り専用スナップショットを登録しました。原本は変更していません。"
   }}catch{let text=error.localizedDescription;DispatchQueue.main.async{self.message=text;self.error=true;self.projectBusy=false}}
  }
 }
}
struct SnapshotPreview:View {
 let plan:SnapshotPlan;let busy:Bool;let approve:()->Void
 @Environment(\.dismiss) private var dismiss
 var excludedTotal:Int {let x=plan.excluded;return x.unsupported+x.protected+x.symlink+x.oversized+x.binary+x.unsafe}
 var body:some View{VStack(alignment:.leading,spacing:14){
  Text("取込前プレビュー").font(.title2.weight(.semibold))
  Text("この画面を開いただけではコピーされません。表示名：\(plan.displayName)").foregroundStyle(.secondary)
  HStack{Text("ID：\(plan.id)");Spacer();Text("対象 \(plan.eligibleFiles)件・除外 \(excludedTotal)件")}
  Text("確認番号：\(plan.fingerprint)").font(.system(.callout,design:.monospaced)).textSelection(.enabled)
  Text("完全ダイジェスト：\(plan.digest)").font(.system(.caption,design:.monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
  GroupBox("コピー対象のファイル名") {ScrollView{LazyVStack(alignment:.leading,spacing:5){ForEach(plan.files){f in Text("\(f.path)  (\(f.bytes) bytes)").font(.system(.caption,design:.monospaced)).textSelection(.enabled)}}.frame(maxWidth:.infinity,alignment:.leading)}.frame(height:220).padding(6)}
  Text("除外内訳：非対応 \(plan.excluded.unsupported)・保護対象 \(plan.excluded.protected)・リンク \(plan.excluded.symlink)・サイズ \(plan.excluded.oversized)・バイナリ \(plan.excluded.binary)・安全性 \(plan.excluded.unsafe)").font(.caption).foregroundStyle(.secondary)
  Text("「Owner確認へ」を押すとmacOSの確認ダイアログが開きます。許可した場合だけ、選択ファイルを非公開スナップショットへコピーします。元フォルダは編集しません。").font(.callout).fixedSize(horizontal:false,vertical:true)
  HStack{Button("戻る"){dismiss()}.disabled(busy);Spacer();if busy{ProgressView().controlSize(.small)};Button("Owner確認へ"){approve()}.buttonStyle(.borderedProminent).disabled(busy)}
 }.padding(22).frame(width:650)}
}
struct DirectPreview:View {
 let plan:DirectWorkspacePlan;let busy:Bool;let approve:()->Void
 @Environment(\.dismiss) private var dismiss
 var body:some View{VStack(alignment:.leading,spacing:14){
  Text("direct登録前の確認").font(.title2.weight(.semibold))
  Text("これは読み取り専用スナップショットではありません。登録後、タスクごとのOwner許可を得たdirect作業だけがこの実フォルダを変更できます。").fixedSize(horizontal:false,vertical:true)
  Text("ID：\(plan.id)").textSelection(.enabled);Text("実フォルダ：\(plan.source)").font(.system(.callout,design:.monospaced)).textSelection(.enabled)
  Text("指紋：\(plan.fingerprint)").font(.system(.callout,design:.monospaced)).textSelection(.enabled)
  Text("確認番号（5分で失効）：\(plan.confirmation)").font(.system(.callout,design:.monospaced)).textSelection(.enabled)
  Text("「Owner確認へ」で別のmacOS確認を開きます。拒否・タイムアウトでは登録されません。MCPはこのパスを受け取りません。").foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
  HStack{Button("戻る"){dismiss()}.disabled(busy);Spacer();if busy{ProgressView().controlSize(.small)};Button("Owner確認へ"){approve()}.buttonStyle(.borderedProminent).disabled(busy)}
 }.padding(22).frame(width:650)}
}
struct Dashboard:View {
 @StateObject var vm=ViewModel()
 var body:some View {
  ScrollView{VStack(alignment:.leading,spacing:20){
   HStack(spacing:16){Image(nsImage:NSApplication.shared.applicationIconImage).resizable().frame(width:64,height:64);VStack(alignment:.leading,spacing:4){Text("Theo Synapse").font(.largeTitle.weight(.semibold));Text("ChatGPTとCodexをつなぐ、Macの作業窓口").foregroundStyle(.secondary)};Spacer();Text(vm.hostState).font(.caption.weight(.semibold)).padding(8).background(vm.hostState.hasPrefix("DIRECT") ? Color.orange.opacity(0.16):Color.green.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius:8))}
   Divider()
   HStack(spacing:40){VStack(alignment:.leading,spacing:6){Text("サービス").foregroundStyle(.secondary);Label(vm.hostState,systemImage:vm.running ? "checkmark.circle.fill":"pause.circle").font(.title2).foregroundStyle(vm.hostState=="UNMANAGED/UNKNOWN" ? Color.red:(vm.running ? Color.green:Color.secondary))};VStack(alignment:.leading,spacing:6){Text("Codex").foregroundStyle(.secondary);Text(vm.codex ? vm.login:"確認待ち").font(.title3)};Spacer();if vm.busy{ProgressView().controlSize(.small)}}
   GroupBox {VStack(alignment:.leading,spacing:10){Text("1  このMacの準備").font(.headline);Text("Node.js 24以上とCodexの導入・ログインが必要です。初期設定で専用デモを作ります。既存プロジェクトやAPIキーは移しません。").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true);HStack{Button(vm.installed ? "準備状態を確認":"初期設定"){vm.perform(vm.installed ? "status":"setup")}.buttonStyle(.borderedProminent);Text(vm.installed ? "専用環境を設定済み":"未設定").font(.caption).foregroundStyle(.secondary)}}.frame(maxWidth:.infinity,alignment:.leading).padding(8)}
   GroupBox {VStack(alignment:.leading,spacing:10){Text("2  読み取り専用SNAPSHOTを追加（Ownerのみ）").font(.headline);Text("対象ファイルをprivate snapshotへコピーします。原本は編集しません。directの実フォルダとは別です。").font(.callout).foregroundStyle(.secondary);HStack{TextField("例: my-project",text:$vm.projectID).textFieldStyle(.roundedBorder).frame(width:210);Button("フォルダを選んでプレビュー"){vm.chooseProjectFolder()}.disabled(!vm.installed||vm.projectBusy);if vm.projectBusy{ProgressView().controlSize(.small)}};Text("SNAPSHOT：\(vm.projects)").font(.caption).foregroundStyle(.secondary)}.frame(maxWidth:.infinity,alignment:.leading).padding(8)}
   GroupBox {VStack(alignment:.leading,spacing:10){Text("3  DIRECT実フォルダを登録（Ownerのみ・任意）").font(.headline);Text("MCPは任意パスを登録できません。実フォルダ、ID、指紋を確認し、5分以内の確認番号と別のmacOS許可が必要です。theo-lab と chappy-signal は拒否されます。").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true);HStack{TextField("例: actual-project",text:$vm.projectID).textFieldStyle(.roundedBorder).frame(width:210);Button("実フォルダを選んで確認"){vm.chooseDirectFolder()}.disabled(!vm.installed||vm.projectBusy);if vm.projectBusy{ProgressView().controlSize(.small)}};Text("DIRECT：\(vm.directProjects)").font(.caption).foregroundStyle(.secondary)}.frame(maxWidth:.infinity,alignment:.leading).padding(8)}
   GroupBox {VStack(alignment:.leading,spacing:10){Text("4  サービス").font(.headline);Text("READONLY(8) と DIRECT(10) は同じprivate socketを共有するため同時起動しません。UNMANAGED/UNKNOWN は手動hostであり、このアプリは停止・引継ぎしません。").font(.caption).foregroundStyle(.secondary);HStack{Button("READONLYを起動"){vm.perform("start")}.disabled(!vm.installed || vm.running);Button("READONLYを停止"){vm.perform("stop")}.disabled(!vm.running || !vm.hostState.hasPrefix("READONLY"));Button("DIRECTを起動"){vm.startDirect()}.disabled(!vm.installed || vm.running);Button("DIRECTを停止"){vm.stopDirect()}.disabled(!vm.running || !vm.hostState.hasPrefix("DIRECT"));Spacer();Button("接続診断"){vm.perform("smoke")}.disabled(!vm.running)}}.frame(maxWidth:.infinity,alignment:.leading).padding(8)}
   GroupBox {VStack(alignment:.leading,spacing:8){Text("5  ChatGPT接続の状態").font(.headline);Text("Mac版：\(vm.chatGPTConnection)").font(.callout.weight(.semibold)).fixedSize(horizontal:false,vertical:true);Text("接続診断はMac内のMCP応答だけを確認します。ChatGPTからの実接続はこの画面だけでは証明できないため、未確認と表示します。READONLY(8) と DIRECT(10) はローカル状態表示であり、snapshot と direct 実フォルダ登録は別の機能です。Tunnel・認証情報・履歴を読み書き・コピーしません。").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true);HStack{Button("ローカル情報"){NSWorkspace.shared.open(DesktopHost().base)}.disabled(!vm.installed);Button("使い方"){if let u=Bundle.main.url(forResource:"START_HERE_JA",withExtension:"txt"){NSWorkspace.shared.open(u)}}}}.frame(maxWidth:.infinity,alignment:.leading).padding(8)}
   Text(vm.message).font(.callout).foregroundStyle(vm.error ? Color.red:Color.primary).fixedSize(horizontal:false,vertical:true).frame(maxWidth:.infinity,alignment:.leading).textSelection(.enabled)
   HStack{Text("Macアプリ 0.1.9 · Core 0.0.5 · O.P.P Studio").font(.caption).foregroundStyle(.secondary);Spacer();Button("更新"){vm.perform("status")}}
  }.padding(28).frame(width:720)}.disabled(vm.busy).task{vm.perform("status")}.sheet(item:$vm.snapshotPlan){plan in SnapshotPreview(plan:plan,busy:vm.projectBusy){vm.importProject(plan)}}.sheet(item:$vm.directPlan){plan in DirectPreview(plan:plan,busy:vm.projectBusy){vm.registerDirect(plan)}}
 }
}
final class AppDelegate:NSObject,NSApplicationDelegate {
 func applicationDidFinishLaunching(_ notification:Notification){NSApp.activate(ignoringOtherApps:true)}
 func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{true}
}
@main struct TheoSynapseApp:App {
 @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
 init(){
  if CommandLine.arguments.count>=3 && CommandLine.arguments[1]=="--manage" {
   do{let r=try DesktopHost().action(CommandLine.arguments[2]);let data=try JSONSerialization.data(withJSONObject:r,options:[.sortedKeys]);print(String(decoding:data,as:UTF8.self));exit(0)}
   catch{let data=(try? JSONSerialization.data(withJSONObject:["error":error.localizedDescription],options:[.sortedKeys])) ?? Data();print(String(decoding:data,as:UTF8.self));exit(1)}
  }
 }
 var body:some Scene {WindowGroup{Dashboard()}.windowResizability(.contentSize)}
}
